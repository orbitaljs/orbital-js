var rpc = require('./rpc');
var path = require('path');
var process = require('process');
var fs = require('fs');
var app = require('app');
var child_process = require('child_process');

var initialized = false;

function initialize(options) {
	if (initialized)
		throw Error("Already initialized");

	if (!options)
		throw Error("'options' parameter is required");

	if (!options.main)
		throw Error("'options.main' parameter is required");

	initialized = true;

	// Start RPC
	try {
		console.log("Initializing RPC");
		if (process.env.PIPE)
			rpc.start(process.env.PIPE);
		else
			rpc.start();
	} catch (e) {
		console.log("Failed to initialize RPC", e);
		throw e;
	}

	// TODO: all these paths assume a mac-style .app package
	// This is obviously not going to work on windows

	// If we've been passed the PIPE environment variable, that means we're in inverted mode
	if (!process.env.PIPE) {

		console.log("Initializing JVM");
		try {
			var jvmPath = path.join(module.filename, "../../../../Java/bin/java");

			var jarFolder = path.join(module.filename, "../../../../Java");
			var files = fs.readdirSync(jarFolder);
			var cp = [];
			files.forEach(function(file) {
				if (file.indexOf('.jar') != -1) {
					cp.push(jarFolder + "/" + file);
				}
			});

			var opts = { 
				env: process.env,
				stdio: ['ignore', process.stdout, process.stderr]
			};

			var args = [ 
				// "-verbose:class", 
				"-cp", cp.join(':'), 
				'-DPIPE=' + rpc.getName(),
				'-DMAIN=' + options.main,
				"com.codano.orbital.OrbitalAppMain"
			];

			console.log(jvmPath, args, opts);

			child_process.spawn(jvmPath, args, opts);

			// var node = process.platform == 'darwin' 
			// 	? path.resolve(process.resourcesPath, '..', 'Frameworks',
   //                   'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper')
			// 	: process.execPath;

			// console.log(node);
			// var opts = { 
			// 	env: {},
			// 	stdio: ['ignore', process.stdout, process.stderr]
			// };
			// opts.env['ATOM_SHELL_INTERNAL_RUN_AS_NODE'] = 1;
			// opts.env['PIPE'] = rpc.getName();
			// opts.env['MAIN'] = options.main;

			// var shim = path.resolve(__dirname, 'shim.js');
			// console.log(node, shim);

			// var jvm = child_process.spawn(node, [ shim ], opts);
		} catch (e) {
			console.log("Failed to initialize the JVM", e);
			throw e;
		}
	}
}

module.exports = {
	init: function(options) {
		initialize(options);
	},

	registerEndpoint: function(endpoint, handler) {
		rpc.registerEndpoint(endpoint, handler);
	},

	call: function() {
		rpc.call.apply(rpc, arguments);
	}
};
