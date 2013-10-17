/***
  Routes controller, of sorts
  All routes logic and management goes here
***/

var _   = require('underscore'),
    fs  = require('fs'),
    async = require('async'),
    caching = require("./caching.js"),
    validate = require('./validate.js'),
    utils  = require('../../../lib/utils.js'),
    AppUtils  = require('../../../lib/AppUtils.js');

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

// return authentication object
var getAuthentication = function(r, authentication) {

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

  return (!_.isUndefined(r.authentication[authentication])?r.authentication[authentication]:false);

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

    // do the authentication request, if required
    if (apicall.authentication) {
      series.auth = function(callback) {

        var auth_lib = require(apicall.authentication.library);

        auth_lib[apicall.authentication.callback](opts, function(err, data) {
          return callback(err, data);
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
          responseObj.ApiKey = req.ApiKey;

          lib[apicall.callback](opts, responseObj, function(responseObj) { 

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
            res.header("X-Webhooksio-RequestId", request_id);
            responseObj.request_id = request_id;
            
            // send the response back to the client  
            if (responseObj.error) {

              var errorResponse = buildErrorResponse(responseObj, error_opts);
              



              return res.send(errorResponse.status_code, errorResponse);  

            }else {

              try{
                var output_lib = require(apicall.outputLibrary);
                output_lib[apicall.callback](responseObj, function(err, output) {
                return res.send(responseObj.getHttpCode(), responseObj.getData()); 
                });
              } catch (ex) {
                console.log(ex)
                // there was an error loading the output lib, so just dump what is in the response obj...
                return res.send(responseObj.getHttpCode(), responseObj.getData()); 
              }
            }

        });


    });
     
  }

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
      // TODO: Get this going over to Loggly...
      //console.log(errorResponse)
      //console.log(err.stack);  
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
  getAuthentication: getAuthentication,
  combineWithAuthentication: combineWithAuthentication,
  parseRoute: parseRoute,
  invalidRoute: invalidRoute,
  internalError: internalError,
  invalidAuthetication: invalidAuthetication
}