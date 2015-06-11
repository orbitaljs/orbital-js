var jvm = require('bindings')('jvm');
var path = require('path');
var fs = require('fs');
var process = require('process');

var jvmPath = path.join(module.filename, "../../../../Java/lib/server/libjvm.dylib");
console.log(jvmPath);
jvm.load(jvmPath);
var jarFolder = path.join(module.filename, "../../../../Java");
var files = fs.readdirSync(jarFolder);
var cp = [];
files.forEach(function(file) {
	if (file.indexOf('.jar') != -1) {
		cp.push(jarFolder + "/" + file);
	}
});

console.log(jarFolder);

// TODO: semicolon on windows
jvm.init(/*"-verbose:class", */"-Djava.class.path=" + cp.join(':'), '-DPIPE=' + process.env.PIPE);
jvm.run(process.env.MAIN);

