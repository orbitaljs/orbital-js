var rpc = require('./rpc');
var path = require('path');
var process = require('process');
var fs = require('fs');
var app = require('app');
var child_process = require('child_process');
var os = require('os');

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
			rpc.start(process.env.PIPE, true);
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
		var isWindows = /^win/.test(os.platform());

		try {
			var javaRoot = isWindows
				? "../../../../java"
				: "../../../../Java";

			var jarFolder = path.join(module.filename, javaRoot);
			var jvmPath = path.join(jarFolder, isWindows ? "bin/java.exe" : "bin/java");
			var files = fs.readdirSync(jarFolder);
			var cp = [];
			files.forEach(function(file) {
				if (file.indexOf('.jar') != -1) {
					cp.push(path.join(jarFolder, file));
				}
			});

			var opts = { 
				env: process.env,
				stdio: isWindows ? ['ignore', 'pipe', 'pipe'] : ['ignore', process.stdout, process.stderr]
			};

			var args = [ 
				// "-verbose:class", 
				"-cp", cp.join(isWindows ? ';' : ':'), 
				'-DPIPE=' + rpc.getName(),
				'-DMAIN=' + options.main,
				"com.codano.orbital.OrbitalAppMain"
			];

			// if (isWindows) {
			// 	args.unshift(jvmPath);
			// 	args.unshift("/c");
			// 	args.unshift("/d");

			// 	jvmPath = "cmd";				
			// }

			var jvm = child_process.spawn(jvmPath, args, opts);
			if (isWindows) {
				jvm.stdout.on('data', function (data) {
					console.log(data.toString('utf-8'));
				});
				jvm.stderr.on('data', function (data) {
					console.log(data.toString('utf-8'));
				});
			}

			console.log(jvmPath, args);

			jvm.on('close', function(code) {
				console.log("JVM died with code " + code);
			});
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
