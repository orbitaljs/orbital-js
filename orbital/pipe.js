var os = require('os');
var fs = require('fs');
var path = require('path');
var util = require('util');
var stream = require('stream');
var child_process = require('child_process');
var net = require('net');

/**
 * A cross platform IPC pipe that works in either Windows or a POSIX environment and
 * can interop with other platforms by virtue of using underlying streams that are 'file-like' 
 * in both environments.
 * 
 * A pipe is a duplex stream that can be both read and written.
 *
 * In Windows, the pipe is available at \\?\pipe\ipc-{id}. In POSIX the pipe is available
 * in two FIFOs that live under {id}/i and {id}/o -- the pipe ID specifies a directory containing
 * the two endpoints.
 */

var MAGIC = {};
var isWindows = /^win/.test(os.platform());

var SERVER = 0;
var CLIENT = 1;

var Pipe = function(magic, name, mode) {
	// Callers should use the static constructors
	if (magic != MAGIC)
		throw "Use Pipe.create or Pipe.open to create a pipe";

	this.__open = true;
	this.__name = name;
	this.__mode = mode;
	this.__queuedWrites = [];
	this.__readBuffer = Buffer(64 * 1024);

	stream.Duplex.call(this);
}

util.inherits(Pipe, stream.Duplex);

Pipe.create = function() {
	var name = isWindows ? this.__createWindows() : this.__createPosix();
	var pipe = new Pipe(MAGIC, name, SERVER);
	isWindows ? pipe.__openWindows() : pipe.__openPosix();
	return pipe;
}

Pipe.open = function(name) {
	var pipe = new Pipe(MAGIC, name, CLIENT);
	isWindows ? pipe.__openWindows() : pipe.__openPosix();
	return pipe;
}

Pipe.openServer = function(name) {
	var pipe = new Pipe(MAGIC, name, SERVER);
	isWindows ? pipe.__openWindows() : pipe.__openPosix();
	return pipe;
}

Pipe.__createWindows = function() {
	return this.__generateEndpoint();
}

Pipe.__createPosix = function() {
	return os.tmpdir() + "/ipc-" + this.__generateEndpoint();
}

Pipe.__generateEndpoint = function() {
	return require('crypto').randomBytes(32).toString('hex');
}

Pipe.prototype.__openWindows = function() {
	console.log("RPC pipe (named pipe):\n" + this.__name);
	var addr = '\\\\?\\pipe\\' + this.__name;

	if (this.__mode == SERVER) {
		var server = net.createServer(function(c) {
			console.log("Connected to named pipe as server");
			this.__writer = c;
			this.__drainWriteQueue();
			this.emit('open');

			c.on('data', function(data) {
				this.push(data);
			}.bind(this));
		}.bind(this)).listen(addr);
	} else {
		var client = net.createConnection({ path: addr }, function() {
			console.log("Connected to named pipe as client");
			this.__writer = client;
			this.__drainWriteQueue();
			this.emit('open');
		}.bind(this));

		client.on('data', function(data) {
			this.push(data);
		}.bind(this));
	}
}

Pipe.prototype.__openPosix = function() {
	console.log("RPC pipe (fifo): " + this.__name);

	// On posix environments, the PIPE env variable specifies a folder 
	// where we create two FIFOs: i and o.

	// Create the FIFOs in a tmp folder
	var fifo = path.join(this.__name, 'fifo');
	if (!fs.existsSync(fifo)) {
		var tmp = path.join(this.__name, 'tmp');

		if (!fs.existsSync(this.__name))
			fs.mkdirSync(this.__name);
		if (!fs.existsSync(tmp))
			fs.mkdirSync(tmp);

		// TODO: Move to native module
		child_process.spawnSync('mkfifo', [path.join(tmp, 'i')]);
		child_process.spawnSync('mkfifo', [path.join(tmp, 'o')]);

		// TODO: This is potentially a race: if we find that it already exists by now we
		// should abort and use the other's FIFOs.
		fs.renameSync(tmp, fifo);
	}

	// We write to the 'i' pipe in server mode and 'o' pipe in client mode
	fs.open(path.join(fifo, this.__mode == SERVER ? 'i' : 'o'), "w", function(err, fd) {
		console.log("RPC write pipe open");
		this.__writeFd = fd;
		this.__writer = fs.createWriteStream(null, { fd: fd });
		this.__writer.on('end', function() {
			this.__die("Write pipe closed");
		});

		this.__drainWriteQueue();
		this.__checkOpenPosix();
	}.bind(this));

	// We read from the 'o' pipe in server mode and the 'i' pipe in client mode
	fs.open(path.join(fifo, this.__mode == CLIENT ? 'i' : 'o'), "r", function(err, fd) {
		console.log("RPC read pipe open");
		this.__readFd = fd;
		fs.read(this.__readFd, this.__readBuffer, 0, this.__readBuffer.length, null, this.__onRead.bind(this));
		this.__checkOpenPosix();
	}.bind(this));
}

Pipe.prototype.close = function() {
	// Ignore multiple close calls
	if (!this.__open)
		return;

	fs.closeSync(this.__writeFd);
	delete this.__writeFd;
	fs.closeSync(this.__readFd);
	delete this.__readFd;

	this.emit('end');
}

Pipe.prototype.__checkOpenPosix = function() {
	if (this.__readFd !== undefined && this.__writeFd !== undefined) {
		// The server is responsible for cleanup
		if (this.__mode == SERVER)
			this.__cleanupPosix();
	}	

	this.emit('open');
}

Pipe.prototype.__cleanupPosix = function() {
	var fifo = path.join(this.__name, 'fifo');
	fs.unlinkSync(path.join(fifo, 'i'));
	fs.unlinkSync(path.join(fifo, 'o'));
	fs.rmdirSync(fifo);
	fs.rmdirSync(this.__name);
}

Pipe.prototype._read = function(size) {
	// Advisory
}

Pipe.prototype.__drainWriteQueue = function() {
	for (var i = 0; i < this.__queuedWrites.length; i++) {
		this.__writer.write.apply(this.__writer, this.__queuedWrites[i]);
	}

	delete this.__queuedWrites;
}

Pipe.prototype.__onRead = function(err, bytesRead, buffer) {
	if (err || bytesRead == 0) {
		// TODO: error
		this.close();
		return;
	}

	this.push(buffer.slice(0, bytesRead));

	// Always be reading
	fs.read(this.__readFd, this.__readBuffer, 0, 
		this.__readBuffer.length, null, this.__onRead.bind(this));
}

Pipe.prototype._write = function(chunk, enc, cb) {
	if (this.__writer) {
		try {
			this.__writer.write(chunk, enc, cb);
		} catch (e) {
			this.emit('error', e);
			this.close();
		}
	} else {
		this.__queuedWrites.push([chunk, enc, cb]);
	}
}

module.exports = Pipe;


if (require.main === module) {
	var pipeName = process.argv[2];
	if (pipeName) {
		var pipe = Pipe.open(pipeName);
		pipe.on('data', function(buf) {
			console.log("read: " + buf);
			setTimeout(function() {
				pipe.write("PONG!");
			}, 500);
		});
	} else {
		var pipe = Pipe.create(pipeName);
		pipe.write(new Buffer("PING 0"));
		pipe.on('data', function(buf) {
			console.log("read: " + buf);
			setTimeout(function() {
				pipe.write("PING!");
			}, 500);
		});
	}

	pipe.on('end', function() {
		console.log("END");
		process.exit(0);
	});
}
