/***
  Routes controller, of sorts
  All routes logic and management goes here
***/

var _   = require('underscore'),
    fs  = require('fs'),
    async = require('async'),
    event_bus = require('bus'),
    caching = require("./caching.js"),
    validate = require('./validate.js'),
    utils  = require('../../../lib/utils.js'),
    AppUtils  = require('../../../lib/AppUtils.js'),
    ApiTokenService = require('../../../lib/ApiToken'),
    AccountService = require('../../../lib/Account'),
    AuthenticationService = require('../../../lib/Authentication'),
    config = require('../../../config');

var eventEmitter = require("../../../lib/EventEmitter");


var parseRoute = function(ac){
  var data = {};
  var finalEndpoint = "";
  var arrEndpoint = ac.endpoint.split("/");
  var placeholder = "";

  data.indexes = [];

  for (var i = 1; i < arrEndpoint.length; i++) {
    placeholder = arrEndpoint[i];
    if(placeholder.search(":") == 0){
      placeholder = placeholder.substr(1, placeholder.length - 1);
      if(ac.endpoint_parameters[placeholder].pattern){
        finalEndpoint = finalEndpoint +  "/" + ac.endpoint_parameters[placeholder].pattern
        data.indexes.push({pos:i, variable: placeholder});
      }else{
        finalEndpoint = finalEndpoint +  "/" + arrEndpoint[i];
      }
    }else{
      finalEndpoint = finalEndpoint +  "/" + arrEndpoint[i];  
    }
  }
  data.endpoint = finalEndpoint + "(.(json|jsonp|html|xml))?";
  ac.endpoint_parsed = data;
}


// return parsed routes
var getRoutes = function(r) {
  
  // verify routes are supplied correctly
  if (_.isUndefined(r) || !_.isString(r) || !fs.existsSync(r)) {
    console.log('Routes file not supplied or not present.');
    process.exit(0);
  }

  r = fs.readFileSync(r, {encoding: 'utf-8'});

  try {
    r = JSON.parse(r);
  } catch(e) {
    console.log('Cannot parse routes file as JSON');
    console.log(e);
    process.exit(0);
  }

  return r.routes;
}

var authenticate = function(apicall, opts, req, res, error_opts, callback){
  
  if(apicall.authentication){
    var token = null;
    var type = null;
    if(req.headers && req.headers.authorization){
      // now make sure it is a bearer type...
      var auth_split = req.headers.authorization.split(" ");
      if(auth_split[0] == 'Bearer'){
        token = auth_split[1];
        type = "Bearer";
      }else if(auth_split[0] == 'client-token-bearer'){
        // decode the payload...
        try{
          var token_payload = ApiTokenService.parseClientBearerToken(auth_split[1]);
          token = token_payload.api_token;
          type = "client-token-bearer";
        }catch(e){
          return returnError(req, res, error_opts, "InvalidClientBearerToken");  
        }
      }else{
        return returnError(req, res, error_opts, "InvalidAutheticationScheme");
      }
    }else if(req.query._token){
      token = req.query._token;
    }

    var required_permissions = null;
    if(apicall.required_permissions){
      required_permissions = apicall.required_permissions;
    }

    AuthenticationService.authenticateRequest(token, opts.url_params.account_id, {required_permissions: required_permissions}, function(Error, ApiToken){
      if(!Error){
        return callback(ApiToken);
      }else{
        return returnFromErrorObj(req, res, Error, error_opts);
      }
    });
  }else{
    return callback(null);
  }
}

// when request is received, check whether the calls parameters are present
// and match those defined in the routes
var parseRequest = function(apicall, req, res, error_opts) {
  
  var opts;

  // post & puts parameters are in req.body, but get parameters are in req.query
  switch(req.route.method) {
    case 'post':
    case 'put':
    case 'delete':
      opts = _.clone(req.body);      
      break;
    default:
      opts = _.clone(req.query);
  }

  // set any of the URL parameters into the opts struct now...
  //console.log(req._parsedUrl);
  //var urlPathParts = req.client.parser.incoming._parsedUrl.pathname.split("/");  
  var urlPathParts = req._parsedUrl.pathname.split("/");  
  opts.url_params = {};
  for(var p=0; p < apicall.endpoint_parsed.indexes.length; p++){
    opts.url_params[apicall.endpoint_parsed.indexes[p].variable] = urlPathParts[apicall.endpoint_parsed.indexes[p].pos];    
  }

  // the error messages array
  var errors = validate.parameters(apicall, opts, req.files);
  
  // if there are some errors
  if(errors.length) {
      // get the request id then go ahead and return the results to the user...
      AppUtils.newId("request", function(request_id){
          var responseObj = utils.Response();
          responseObj.errorCode = "InvalidInput";
          responseObj.request_id = request_id;



          var formatted_errors  = [];
          for(var e=0; e<errors.length; e++){
            var split_error = errors[e].split(" "); 
            formatted_errors.push({property:split_error[0] , msg: errors[e]});
          }
          responseObj.errors = formatted_errors;

          var errorResponse = buildErrorResponse(responseObj, error_opts);
            
          return res.send(errorResponse.status_code, errorResponse);  
      });
  }else{
    // If there are no errors, then delegate the request...
    delegate(apicall, opts, req, res, error_opts);  
  }
}

var delegate = function (apicall, opts, req, res, error_opts) {

  // if there is a call back for this API call
  if(apicall.callback && apicall.library) {
    
    var series = {};

    if (apicall.authentication) {
      series.auth = function(callback) {
        
        authenticate(apicall, opts, req, res, error_opts, function(ApiToken){
          req.ApiToken = ApiToken;
          callback(null);
        });
      }
    }

    // process the API call
    series.request = function(callback) {

      var lib = apicall.library.split("/");
      var cachekey = [lib[lib.length-1], apicall.callback];

      var keys = Object.keys(opts);
      keys.sort();

      for (var k in keys) {

        if (keys[k] == '_use_cache') {
          continue;
        }

        cachekey.push(keys[k]);
        cachekey.push((opts[keys[k]]?opts[keys[k]]:""));
      }

      cachekey = cachekey.join("");

      caching.get((opts._use_cache?apicall.caching:false), cachekey, function(err, cached) {

        // didn't get anything from cache
        if (err || _.isNull(cached)) {

          // load the library
          var lib = require(apicall.library);
          
          // call the callback
          var responseObj = utils.Response();
          responseObj.ApiToken = req.ApiToken;

          // trace what is actually being called...
          lib[apicall.callback](opts, responseObj, req, res, function(responseObj) { 
            // store retrieved value in cache if no error
            if (apicall.cache !== false && !responseObj.error) {
              caching.set(apicall.caching, cachekey, responseObj.getData());
            }

            return callback(responseObj);

          });
        
        }

        // did get from cache
        else {
          console.log('got from cache', cachekey)
          return callback(null, cached);
        }

      });

    }

    async.series(series, function(responseObj) {

      // get the request id then go ahead and return the results to the user...
      AppUtils.newId("request", function(request_id){
            res.header("Webhooksio-Request-Id", request_id);
            responseObj.request_id = request_id;

            // send the response back to the client  
            if (responseObj.error) {

              var errorResponse = buildErrorResponse(responseObj, error_opts);
              return res.send(errorResponse.status_code, errorResponse);  

            }else {

              try{
                var output_lib = require(apicall.outputLibrary);
                
                output_lib[apicall.callback](responseObj, function(err, output) {

                  // add any headers that are located in the response object...
                  var response_headers = responseObj.getHeaders();
                  for(var h=0; h < response_headers.length; h++){
                    res.header(response_headers[h].key, response_headers[h].value);
                  }
                  // add the proper content type...
                  res.header("Content-Type", responseObj.getContentType());

                  // emit the proper event now...
                    if(apicall.event){

                        var event_data = {apicall: apicall, responseObj : responseObj, api_token : req.ApiToken};
                        event_bus.emit(apicall.event, event_data);
                    }
                  // go ahead and return the reponse now!
                  return res.send(responseObj.getHttpCode(), responseObj.getData());
                });
              } catch (ex) {
                //TODO: Throw an error...
                console.log(ex)
                // there was an error loading the output lib, so just dump what is in the response obj...
                //return res.send(responseObj.getHttpCode(), responseObj.getData());
                  return res.send(500, ex);
              }
            }

        });
    });
  }
}

var returnFromErrorObj = function(req, res, ErrorObj, error_opts){
  var message_detail = [];
  AppUtils.newId("request", function(request_id){
      var responseObj = utils.Response();

      responseObj.handleResponse(ErrorObj, null, function(ResponseObj){
        var errorResponse = buildErrorResponse(ResponseObj, error_opts);
        return res.send(errorResponse.status_code, errorResponse);  

      });
  });
}


var returnError = function(req, res, error_opts, errorCode){
  var message_detail = [];
  AppUtils.newId("request", function(request_id){
      var responseObj = utils.Response();
      responseObj.errorCode = errorCode;
      responseObj.request_id = request_id;

      var errorResponse = buildErrorResponse(responseObj, error_opts);
        
      return res.send(errorResponse.status_code, errorResponse);  


  });
}

var invalidRoute = function(req, res, error_opts){
  var message_detail = [];
  AppUtils.newId("request", function(request_id){
      var responseObj = utils.Response();
      responseObj.errorCode = "InvalidUri";
      responseObj.request_id = request_id;

      var errorResponse = buildErrorResponse(responseObj, error_opts);
        
      return res.send(errorResponse.status_code, errorResponse);  


  });
}

var internalError = function(err, req, res, error_opts){
  var formatted_errors = [];
  AppUtils.newId("request", function(request_id){
      var responseObj = utils.Response();
      responseObj.errorCode = "InternalError";
      responseObj.request_id = request_id;

      responseObj.debug_info = err.stack;
      responseObj.errors = formatted_errors;


      var errorResponse = buildErrorResponse(responseObj, error_opts);

      console.log(errorResponse);
      console.log(err.stack);

      // bubble this error up...
      var event_data = {errorResponse: errorResponse, responseObj : responseObj, api_token : req.ApiToken || null};
      event_bus.emit("internal-error", event_data);

      // return the error to the user...
      return res.send(errorResponse.status_code, errorResponse);

  });
}

var invalidAuthetication = function(req, res, error_opts){
  var message_detail = [];
  AppUtils.newId("request", function(request_id){
      var responseObj = utils.Response();
      responseObj.errorCode = "AuthenticationFailed";
      responseObj.request_id = request_id;

      var errorResponse = buildErrorResponse(responseObj, error_opts);
        
      return res.send(errorResponse.status_code, errorResponse);  


  });
}

var buildErrorResponse = function(responseObj, error_opts){
  var message_detail = [];

  for(var e=0; e < responseObj.errors.length; e++){
    message_detail.push({property: responseObj.errors[e].property, message: responseObj.errors[e].msg});
  }

  if(error_opts[responseObj.errorCode]){
    var error_details = error_opts[responseObj.errorCode];
  }else{
    var error_details = error_opts.InternalError;
  }

  return { 
          request_id: responseObj.request_id,
          status_code: error_details.status_code,
          status_text: error_details.status_code_text,
          error_type: responseObj.errorCode,
          error_code: error_details.user_error_code,
          message: error_details.user_message,
          message_detail: message_detail,
          more_info: error_details.detail_url,
          debug_info: responseObj.debug_info
        };
}

var combineWithAuthentication = function(apicall) {

  if (!apicall.authentication) {
    return apicall;
  }

  for (var ap in apicall.authentication.parameters) {
    apicall.parameters[ap] = apicall.authentication.parameters[ap];
  }

  return apicall;

}

module.exports = {
  getRoutes: getRoutes,
  parseRequest: parseRequest,
  combineWithAuthentication: combineWithAuthentication,
  parseRoute: parseRoute,
  invalidRoute: invalidRoute,
  internalError: internalError,
  invalidAuthetication: invalidAuthetication,
  authenticate: authenticate,
  returnError: returnError
}