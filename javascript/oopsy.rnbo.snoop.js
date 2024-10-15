
autowatch = 1;
inlets = 2;
outlets = 3;

var path = "";
var target = "patch";
var samplerate = "48kHz";
var blocksize = "64";
var boost = 1;
var fastmath = 0;
var midi;
var sep = "/";
var dict = new Dict();

function bang() {
	configure();
}

function fileExists(fileName) {
	file = new File(fileName, "read");
	if (file.isopen) { //if succeed in opening file
		file.close();
		return (true);
	} else { //file doesn't exist
		return (false);
	}
}
function configure() {
	var pat = this.patcher.parentpatcher;
	var topmost_pat = pat;
	while (topmost_pat.parentpatcher) {
		topmost_pat = topmost_pat.parentpatcher;
	}
	if (!topmost_pat.filepath) {
		error("oopsy: your patcher needs to be saved first\n");
		pat.message("write");
		return false;
	}
	var export_path = extractFilepath(topmost_pat.filepath) + "build/";
	// send message out to convert this path
	// response will update the variable `path`:
	outlet(2, export_path);
	export_path = path + "/";

	var names = [];
	var cpps = [];
	var errors = 0;
	var configurations = [];

	// find gen~ objects in a patcher:
	function findRnboObjects(pat) {
		dict.clear();
		var default_name = pat.name || "rnbo";
		// iterate all gen~ objects in the patcher
		// to set their export name, path, and scripting name
		var obj = pat.firstobject;
		while (obj) {
			if (obj.maxclass.toString() == "patcher") {
				var subpat = obj.subpatcher()
				if (subpat) findRnboObjects(subpat);
				
			} else if (obj.maxclass.toString() == "rnbo~") {
				var name = default_name;
				if (obj.getattr("title")) { 
					name = obj.getattr("title").toString(); 
				}

                if (name == "untitled") name = "rnbo";
				name = safename(name);

				var local_export_path = export_path + name + "/";

                var confdict = new Dict();
                var confname = confdict.name;
                obj.message("dumptargetconfigdict", "cpp-export", "cpp-code-export", confname);
                confdict.set("output_path", local_export_path);
                confdict.set("export_name", name);
                confdict.set("minimal_export", 1);
                confdict.set("classname", name);

                if (blocksize != undefined) {
                    confdict.set("fixedblocksize", Number(blocksize));
                }

				configurations.push({
					dict: confdict,
					obj: obj
				});

				// this might not work on the first pass, since it can take a little time.
				// dict.import_json(obj.getattr("exportfolder") + obj.getattr("exportname") + ".json")
				
				// var ast = JSON.parse(dict.stringify())
				// if (ast.class == "Module") {
				// 	var nodes = ast.block.children;
				// 	for (var i=0; i<nodes.length; i++) {
				// 		var node = nodes[i];
				// 		if (node.typename == "Data") {
				// 			//var bufname = obj.getattr(node.name)
				// 			var bufname = obj.getattr(node.name)
				// 			var buffer = new Buffer(bufname)
				// 			var frames = buffer.framecount()
				// 			var chans = buffer.channelcount()
				// 			if (frames > 0 && chans > 0) {
				// 				var wavname = node.name + ".wav"
				// 				// write out that file so it can be referenced:
				// 				buffer.send("write", obj.getattr("exportfolder") + wavname);
				// 				//post("found buffer mapped Data", node.name, bufname, wavname, frames, chans)
				// 			}
				// 		} else if (node.typename == "Buffer") {
				// 			// find the corresponding buffer~:
				// 			var bufname = obj.getattr(node.name)
				// 			var buffer = new Buffer(bufname)
				// 			var frames = buffer.framecount()
				// 			var chans = buffer.channelcount()

				// 			if (frames < 0 || chans < 0) {
				// 				error("oopsy: can't find buffer~ "+bufname);
				// 				return;
				// 			}

				// 			// write it out:
				// 			//buffer.send("write", obj.getattr("exportfolder") + bufname + ".wav");

				// 			post("oopsy: consider replacing [buffer "+node.name+"] with [data "+node.name+" "+frames+" "+chans+"]\n"); 
				// 			if (node.name != bufname) { 
				// 				post("and set @"+node.name, bufname, "on the gen~\n"); 
				// 			}
				// 			error("gen~ cannot export with [buffer] objects\n")
				// 			errors = 1;
				// 			return;
				// 		}
				// 	}
				// }
				
				names.push(name);
				cpps.push(local_export_path + name + ".h");
			}
			obj = obj.nextobject;
		}
	}

	findRnboObjects(pat, names, cpps, export_path);

	if (errors) {
		post("oopsy: aborting due to errors\n");
		return;
	} else if (names.length < 1) {
		post("oopsy: didn't find any valid gen~ objects\n");
		return;
	} 

	var name = names.join("_");
	var args = [target, samplerate, "block"+blocksize, "midi"+midi].concat(cpps);
	if (boost) args.push("boost");
	if (fastmath) args.push("fastmath");

	var activeConf = 0;
	const timeout = 20;
	var timeOutCount = timeout;
	var tsk = new Task(
		function doExport() {
			post("executing export task \n");
			post ("active: " + activeConf + " done: " + configurations[activeConf].done + "\n");
			arguments.callee.task.interval = 1000;
			var cancelTask = true;
			if (configurations[activeConf].done === undefined) {
				// active conf has not been triggered, yet
				post("starting export " + activeConf + "\n");
				configurations[activeConf].obj.message("export", "cpp-export", "cpp-code-export", configurations[activeConf].dict.name);
				configurations[activeConf].done = false;
				cancelTask = false;
			}
			else if (configurations[activeConf].done == false) {
				// check if we already have an exported file
				var outpath = configurations[activeConf].dict.get("output_path");
				var fileName = configurations[activeConf].dict.get("export_name");
				var exportFilePath = outpath + fileName + ".h";
				post("checking export " + activeConf + " '" + exportFilePath + "'\n");

				if (fileExists(exportFilePath)) {
					configurations[activeConf].done = true;
					post("finished export " + activeConf + "\n");
					activeConf++;
					timeOutCount = timeout;
	
					if (activeConf >= configurations.length) {
						outlet(1, name)
						outlet(0, args)		
						cancelTask = true;
					}
					else {
						cancelTask = false;
					}
				}
				else {
					cancelTask = false;
				}
			}
	
			if (--timeOutCount < 0) {
				post("error: export did time out.\n")
				cancelTask = true;
			}
			else if (activeConf > configurations.length) {
				post("reached end of configurations.\n")
				cancelTask = true;
			}
			
			if (cancelTask) {
				arguments.callee.task.cancel();
			}
		}, this
	);

	tsk.interval = 10;
	tsk.repeat();
}

// convert names to use only characters safe for variable names
function safename(s) {
	if (/[^a-zA-Z\d_]/.test(s)) {
		return s.replace(/[^a-zA-Z\d_]/g, function(x) {
			return '_' + x.charCodeAt(0).toString(16);
		});
	} else {
		return s;
	}
}

// get the containing folder from a filepath:
function extractFilepath(path) {
	var x;
	x = path.lastIndexOf('/');
	if (x >= 0) { // Unix-based path
		sep = "/"
		return path.substr(0, x+1);
	}
	x = path.lastIndexOf('\\');
	if (x >= 0) { // Windows-based path
		sep = "\\"
		return path.substr(0, x+1);
	}
	return path; // just the filename
}
