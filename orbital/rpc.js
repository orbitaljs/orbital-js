var util = require('util');
var fs = require('fs');
var child_process = require('child_process');
var net = require('net');

var Pipe = require('./Pipe');

var SYNC_BYTE = new Buffer([0xff]);

var TYPE_NULL = 0;
var TYPE_JSON = 1;
var TYPE_BINARY = 2;

var RPC = function() {
	this.__packet = new Buffer(0);
	this.__seqId = 0;
	this.__endpoints = {};
	this.__callbacks = {};
	this.__readBuffer = new Buffer(1024 * 1024);
}

RPC.prototype.getName = function() {
	return this.__pipe.getName();
}

RPC.prototype.start = function(pipe, server) {
	if (pipe === undefined)
		this.__pipe = Pipe.create();
	else
		this.__pipe = server ? Pipe.openServer(pipe) : Pipe.open(pipe);

	this.__pipe.on('data', function(chunk) {
		this.__onPacketDataReceived(chunk);
	}.bind(this));

	this.__pipe.on('end', function() {
		this.__die("Pipe closed");
	}.bind(this));
}

RPC.prototype.registerEndpoint = function(endpoint, fn) {
	this.__endpoints[endpoint] = fn;
}

/**
 * Calls the given endpoint with the given arguments. If a callback function is passed in 'args', 
 * it will be called with the result of the function. The callback must be the last argument to 
 * the function.
 */
RPC.prototype.call = function(endpoint /*, args... */) {
	var args = Array.prototype.slice.call(arguments, 1);

	// Extract a callback, if one exists
	var cb;
	if (typeof(args[args.length - 1]) == 'function') {
		cb = args[args.length - 1];
		args = args.slice(0, args.length - 1);
	}

	if (cb) {
		this.__call(endpoint, args, cb);
	} else {
		this.__callNoReturn(endpoint, args, cb);
	}
}

RPC.prototype.__call = function(endpoint, data, cb) {
	var seqId = ++this.__seqId;
	this.__callbacks[seqId] = cb;

	var packet = { call: true, seqId: seqId, endpoint: endpoint, data: data };
	this.__writePacket(packet);
}

RPC.prototype.__callNoReturn = function(endpoint, data) {
	var packet = { call: true, seqId: 0, endpoint: endpoint, data: data };
	this.__writePacket(packet);
}

RPC.prototype.__processPacket = function(packet) {
	if (packet.endpoint) {
		if (this.__endpoints[packet.endpoint]) {
			var returnValue = this.__endpoints[packet.endpoint].apply(null, packet.data);
			// TODO: try/catch
			if (packet.seqId) {
				// Send it back!
				this.__writePacket({ isCall: false, seqId: packet.seqId, data: returnValue });
			}
		} else {
			this.__log("Endpoint not found: " + packet.endpoint);
		}
	} else {
		var cb = this.__callbacks[packet.seqId];
		if (cb) {
			delete this.__callbacks[packet.seqId];
			cb(packet.data);
		} else {
			this.__log("Callback not found: " + packet.seqId);
		}
	}
}

RPC.prototype.__encodePacket = function(packet) {
	var endpoint = packet.endpoint ? new Buffer(packet.endpoint, 'utf8') : null;
	var data = packet.data ? packet.data : [];

	var capacity = 1;
	capacity += 4; // seqId
	if (endpoint)
		capacity += 4 + endpoint.length;

	var types = [];
	var encodings = [];
	for (var i = 0; i < data.length; i++) {
		var obj = data[i];
		if (obj === null || obj === undefined) {
			encodings[i] = null;
			types[i] = TYPE_NULL;
			capacity++;
		} else if (obj instanceof Buffer) {
			encodings[i] = obj;
			types[i] = TYPE_BINARY;
			capacity += 5 + encodings[i].length;
		} else {
			encodings[i] = new Buffer(JSON.stringify(obj), 'utf8');
			types[i] = TYPE_JSON;
			capacity += 5 + encodings[i].length;
		}
	}

	var buf = new Buffer(capacity);

	var flags = (packet.isCall ? 1 : 0) 
			| (endpoint ? 1 << 1 : 0);
	buf[0] = flags;
	var offset = 1;
	buf.writeIntBE(packet.seqId, offset, 4);
	offset += 4;

	if (endpoint) {
		buf.writeIntBE(endpoint.length, offset, 4);
		offset += 4;
		endpoint.copy(buf, offset);
		offset += endpoint.length;
	}

	for (var i = 0; i < encodings.length; i++) {
		buf[offset++] = types[i];
		if (types[i] == TYPE_NULL)
			continue;
		
		var encoding = encodings[i];
		buf.writeIntBE(encoding.length, offset, 4);
		offset += 4;
		encoding.copy(buf, offset);
		offset += encoding.length;
	}

	return buf;
}

RPC.prototype.__decodePacket = function(bytes) {
	var out = { data: [] };
	
	var flags = bytes[0];
	var offset = 1;
	out.seqId = bytes.readIntBE(offset, 4);
	offset += 4;
	
	out.isCall = (flags & 1);
	var hasEndpoint = (flags & (1 << 1));
	
	if (hasEndpoint) {
		var len = bytes.readIntBE(offset, 4);
		offset += 4;
		out.endpoint = bytes.toString('utf8', offset, offset + len);
		offset += len;
	}

	for (var i = offset; i < bytes.length; i++) {
		switch (bytes[i]) {
		case TYPE_NULL:
			out.data.push(null);
			break;
		case TYPE_BINARY: {
			var length = bytes.readIntBE(i + 1, 4);
			out.data.push(bytes.slice(i + 5, i + 5 + length));
			i += 4 + length;
			break;
		}
		case TYPE_JSON: {
			var length = bytes.readIntBE(i + 1, 4);
			var s = bytes.toString('utf8', i + 5, i + 5 + length);
			out.data.push(JSON.parse(s));
			i += 4 + length;
			break;
		}
		}
	}
	
	return out;
}

RPC.prototype.__checkPacket = function() {
	for (var i = 0; i < 10; i++) {
		if (this.__packet[i] == 0xa) {
			// OK, we have a length. Now do we have enough bytes to fill that packet?
			var len = this.__packet.slice(1, i).toString();
			var length = parseInt(len, 16);
			if (this.__packet.length > i + length) {
				// yep, keep the rest around for another packet
				var packet = this.__decodePacket(this.__packet.slice(i + 1, i + length + 1));
				this.__packet = this.__packet.slice(i + length + 1);
				this.__processPacket(packet);
				return true;
			}
		}
	}

	return false;
}

RPC.prototype.__onPacketDataReceived = function(chunk) {
	this.__packet = Buffer.concat([this.__packet, chunk]);

	while (this.__checkPacket()) {}	
}

RPC.prototype.__writePacket = function(packet) {
	var buf = this.__encodePacket(packet);
	var buffer = Buffer.concat([SYNC_BYTE, new Buffer(buf.length.toString(16) + "\n"), buf]);
	
	// Write in one fell swoop
	this.__pipe.write(buffer, this.__checkWrite.bind(this));
}

RPC.prototype.__checkWrite = function(err) {
	// If the pipe closes, abort the entire app
	if (err) {
		this.__die("Error writing pipe");
	}
}

RPC.prototype.__die = function(reason) {
	this.__log("DIE: " + reason);
	process.exit(1);
};

RPC.prototype.__log = function() {
	try {
		console.log.apply(console, arguments);
	} catch (e) {
		// This can fail if electron is in a bad state (ie: shutting down)
	}
}

var rpc = new RPC();

module.exports = rpc;

if (require.main === module) {
	var pipeName = process.argv[2];
	var rpc = new RPC();
	rpc.start(pipeName, false);

	if (pipeName) {
		rpc.registerEndpoint('ping', function() {
			console.log("PING");
			setTimeout(function() {
				rpc.call("pong");
			}, 500);
		});
	} else {
		rpc.registerEndpoint('pong', function() {
			console.log("PONG");
			setTimeout(function() {
				rpc.call("ping");
			}, 500);
		});

		// Start it off
		rpc.call("ping");
	}
}
