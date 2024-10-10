#!/usr/bin/env node

/*
	Generates and compiles wrapper code for rnbo~ export to Daisy hardware

	Oopsy was authored by Graham Wakefield in 2020-2021 
	and adapted for RNBO by Stefan Brunner in 2024

	Main entry-point is `run(...args)`

	Args are a command-line style argument list, see `help` below
	At minimum they should include at least one path to a .cpp file exported from rnbo~

	`run`:
	- parses these args
	- configures a target (JSON definition, #defines, samplerate, etc)
	- visits each .cpp file via `analyze_cpp()` to define "app" data structures
	- further configuration according to cpp analysis
	- visits each "app" via `generate_app()` to prepare data for code generation
	- generates a .cpp file according to the apps and options
	- invokes arm-gcc to compile .cpp to binary, then dfu-util to upload to daisy

	`analyze_cpp`:
	- defines a "rnbo" data structure representing features in the rnbo patcher

	`generate_app`:
	- configure an "daisy" object representing features in the hardware
	- configure a "rnbo" object representing features in the .cpp patch

	The general idea here is that there is a list of named "nodes" making a graph
	most nodes are sources, 
		they may have a list of `to` destinations
		they may have a `src` field naming another node they map from
	some nodes are sinks, and have a list of 'from' sources

*/
const fs = require("fs"),
	path = require("path"),
	os = require("os"),
	assert = require("assert");
const {exec, execSync, spawn} = require("child_process");
const { posixify_path, interpolate, template, asCppNumber, checkBuildEnvironment, help, component_defs, generate_target_struct } = require("./oopsy.shared.js");

const [ build_tools_path, has_dfu_util ] = checkBuildEnvironment();

let watchers = []

function RNBOLibError () {};
RNBOLibError.prototype = new Error();

// the script can be invoked directly as a command-line program,
// or it can be embedded as a node module
if (require.main === module) {
	run(...process.argv.slice(2))
} else {
	module.exports = function() {
		let args = [...arguments];
		let retryCount = 5;
		let interval = 0;
		return new Promise(function tryRun(resolve, reject) {
			if (--retryCount > 0) {
				setTimeout(function() {
					try {
						run(...args);
						resolve();
					}
					catch (e) {
						interval = 1000;
						if (e instanceof RNBOLibError) {
							console.log("Could not find RNBO Lib retrying.");
							return tryRun(resolve, reject);
						}
						else {
							reject(e.message);
						}
					}
				}, interval);
			}
			else {
				reject('Error looking for RNBO Libs.');
			}
		});
	}
}

function run() {
	let args = [...arguments]
	let action = "upload"
	let target
	let target_path
	let watch = false
	let cpps = []
	let samplerate = 48
	let blocksize = 48
	let midiuse = "none";
	let options = {}

	checkBuildEnvironment();
	
	if (args.length == 0) {
		console.log(help)
		return;
	}

	args.forEach(arg => {
		switch (arg) {
			case "help": {console.log(help); process.exit(0);} break;
			case "generate":
			case "gen": action="generate"; break;
			case "upload":
			case "up": action="upload"; break;

			case "pod":
			case "field":
			case "petal":
			case "patch": 
			case "patch_sm":
			case "versio": target = arg; break;
			case "bluemchen": target_path = path.join(__dirname, "seed.bluemchen.json"); break;
			case "nehcmeulb": target_path = path.join(__dirname, "seed.nehcmeulb.json"); break;

			case "watch": watch=true; break;

			case "96kHz": 
			case "48kHz": 
			case "32kHz": samplerate = +(arg.match(/(\d+)kHz/)[1]); break; 

			case "block1":
			case "block2":
			case "block4":
			case "block6":
			case "block8":
			case "block12":
			case "block16":
			case "block24":
			case "block32":
			case "block48": 
			case "block64": 
			case "block96": 
			case "block128":
			case "block512":
			case "block256": blocksize = +(arg.match(/block(\d+)/)[1]); break;

			case "writejson":
			case "nooled": 
			case "boost": 
			case "fastmath": options[arg] = true; break;

			case "midinone":
			case "midiusb":
			case "midiuart": midiuse = arg.match(/midi(.+)/)[1]; break;

			default: {
				// assume anything else is a file path:
				if (!fs.existsSync(arg)) {
					console.log(`oopsy error: ${arg} is not a recognized argument or a path that does not exist`)
					process.exit(-1)
				}
				if (fs.lstatSync(arg).isDirectory()) {
					// add a whole folder full of cpps:
					cpps = cpps.concat(fs.readdirSync(arg)
						.filter(s => path.parse(s).ext == ".cpp") 
						.map(s => path.join(arg, s))
					)
				} else {	
					let p = path.parse(arg);
					switch(p.ext) {
						case ".json": {target_path = arg; target = ""}; break;
						case ".h":
						case ".cpp": cpps.push(arg); break;
						// case ".gendsp":
						// case ".maxpat":
						// case ".maxhelp": {pat_path = arg}; break;
						default: {
							console.warn("unexpected input", arg);
						}
					}
				}
			}
		}
	});

	// remove duplicates:
	cpps = cpps.reduce(function (acc, s) {
		if (acc.indexOf(s) === -1) acc.push(s)
		return acc
	}, []);

	var rnboLibSrcPath = path.join(path.dirname(cpps[cpps.length - 1]), "common")
	var libAvailable = fs.existsSync(rnboLibSrcPath)
	if (!libAvailable) throw new RNBOLibError();

	cpps.sort((a,b)=>{
		return path.basename(a) < path.basename(b) ? -1 : 0;
	})

	let OOPSY_TARGET_SEED = 0

	// configure target:
	if (!target && !target_path) target = "patch";
	if (!target_path) {
		target_path = path.join(__dirname, `daisy.${target}.json`);
	} else {
		OOPSY_TARGET_SEED = 1
		target = path.parse(target_path).name.replace(".", "_")
	}
	console.log(`Target ${target} configured in path ${target_path}`)
	assert(fs.existsSync(target_path), `couldn't find target configuration file ${target_path}`);
	const hardware = JSON.parse(fs.readFileSync(target_path, "utf8"));
	hardware.max_apps = hardware.max_apps || 1

	// The following is compatibility code, so that the new JSON structure will generate the old JSON structure
	// At the point that the old one can be retired (because e.g. Patch, Petal etc can be defined in the new format)
	// this script should be revised to eliminate the old workflow
	{
		hardware.inputs = hardware.inputs || {}
		hardware.outputs = hardware.outputs || {}
		hardware.datahandlers = hardware.datahandlers || {}
		hardware.labels = hardware.labels || {
			"params": {},
			"outs": {},
			"datas": {}
		}
		hardware.inserts = hardware.inserts || []
		hardware.defines = hardware.defines || {}
		hardware.struct = "";

		if (hardware.components) {
			hardware.struct = generate_target_struct(hardware);
			// generate IO
			for (let component of hardware.components) {

				// meta-elements are handled separately
				if (component.meta) {
					
				} else {
					// else it is available for mapping:

					for (let mapping of component.mapping) {
						let name = template(mapping.name, component);
						if (mapping.get) {
							// an input
							hardware.inputs[name] = {
								code: template(mapping.get, component),
								automap: component.automap && name == component.name,
								range: mapping.range,
								where: mapping.where
							}
							hardware.labels.params[name] = name
						}
						if (mapping.set) {
							// an output
							hardware.outputs[name] = {
								code: template(mapping.set, component),
								automap: component.automap && name == component.name,
								range: mapping.range,
								where: mapping.where || "audio"
							}
							hardware.labels.outs[name] = name
						}
					}
				}
			}
		}

		for (let alias in hardware.aliases) {
			let map = hardware.aliases[alias]
			if (hardware.labels.params[map]) hardware.labels.params[alias] = map
			if (hardware.labels.outs[map]) hardware.labels.outs[alias] = map
			if (hardware.labels.datas[map]) hardware.labels.datas[alias] = map
		}

		if (OOPSY_TARGET_SEED) hardware.defines.OOPSY_TARGET_SEED = OOPSY_TARGET_SEED
	}

	// consolidate hardware definition:
	hardware.samplerate = samplerate
	if (hardware.defines.OOPSY_IO_COUNT == undefined) hardware.defines.OOPSY_IO_COUNT = 2
	if (!hardware.max_apps) hardware.max_apps = 1;

	hardware.defines.OOPSY_SAMPLERATE = samplerate * 1000
	hardware.defines.OOPSY_BLOCK_SIZE = blocksize
	hardware.defines.OOPSY_BLOCK_RATE = hardware.defines.OOPSY_SAMPLERATE / blocksize

	//hardware.defines.OOPSY_USE_LOGGING = 1
	//hardware.defines.OOPSY_USE_USB_SERIAL_INPUT = 1

	// verify and analyze cpps:
	assert(cpps.length > 0, "an argument specifying the path to at least one rnbo~ exported cpp file is required");
	if (hardware.max_apps && cpps.length > hardware.max_apps) {
		console.log(`this target does not support more than ${hardware.max_apps} apps`)
		cpps.length = hardware.max_apps
	}

	let apps = cpps.map(cpp_path => {
		var basepath = path.dirname(cpp_path);
		var descfile = path.join(basepath, "description.json")
		assert(fs.existsSync(descfile), `couldn't find description file ${descfile}`);
		return {
			path: cpp_path,
			patch: analyze_json(fs.readFileSync(descfile, "utf8"), hardware, descfile)
		}
	})
	let build_name = apps.map(v=>v.patch.name).join("_")

	// configure build path:
	const build_path = path.join(__dirname, `build_${build_name}_${target}`)
	console.log(`Building to ${build_path}`)
	// ensure build path exists:
	fs.mkdirSync(build_path, {recursive: true});

	// now move the actual RNBO lib sources to the build path)
	var rnboLibPath = path.join(build_path, "common");
	if (apps.length) {
		fs.rmSync(rnboLibPath, { force: true, recursive: true });
		fs.renameSync(rnboLibSrcPath, rnboLibPath);
	}

	let config = {
		build_name: build_name,
		build_path: build_path,
		target: target,
		hardware: hardware,
		apps: apps,
		midiuse: midiuse
	}

	let defines = hardware.defines;

	if (defines.OOPSY_TARGET_HAS_MIDI_INPUT || defines.OOPSY_TARGET_HAS_MIDI_OUTPUT) {
		if (midiuse == "usb") {
			defines.OOPSY_TARGET_USES_MIDI_USB = 1
		}
		else if (midiuse == "uart") {
			defines.OOPSY_TARGET_USES_MIDI_UART = 1
		}
	}

	if (apps.length > 1) {
		defines.OOPSY_MULTI_APP = 1
		// generate midi-handling code for any multi-app on a midi-enabled platform
		// so that program-change messages for apps will work:
		if (hardware.defines.OOPSY_TARGET_HAS_MIDI_INPUT) {
			if (midiuse == "usb") {
				defines.OOPSY_TARGET_USES_MIDI_USB = 1
			}
			else if (midiuse == "uart") {
				defines.OOPSY_TARGET_USES_MIDI_UART = 1
			}
		}
	}
	if (options.nooled && defines.OOPSY_TARGET_HAS_OLED) {
		delete defines.OOPSY_TARGET_HAS_OLED;
	}
	if (defines.OOPSY_TARGET_HAS_OLED && defines.OOPSY_HAS_PARAM_VIEW) {
		defines.OOPSY_CAN_PARAM_TWEAK = 1
	}
	if (defines.OOPSY_TARGET_HAS_OLED) {
		if (!defines.OOPSY_OLED_DISPLAY_WIDTH) defines.OOPSY_OLED_DISPLAY_WIDTH = 128
		if (!defines.OOPSY_OLED_DISPLAY_HEIGHT) defines.OOPSY_OLED_DISPLAY_HEIGHT = 64
	}
	if (options.fastmath) {
		hardware.defines.GENLIB_USE_FASTMATH = 1;
	}

	const makefile_path = path.join(build_path, `Makefile`)
	const bin_path = path.join(build_path, "build", build_name+".bin");
	const maincpp_path = path.join(build_path, `${build_name}_${target}.cpp`);
	fs.writeFileSync(makefile_path, `
# Project Name
TARGET = ${build_name}
# Sources -- note, won't work with paths with spaces
CPP_SOURCES = ${posixify_path(path.relative(build_path, maincpp_path).replace(" ", "\\ "))}
C_SOURCES = ../tlsf.c

# Library Locations
LIBDAISY_DIR = ${(posixify_path(path.relative(build_path, path.join(__dirname, "libdaisy"))).replace(" ", "\\ "))}
APP_TYPE = BOOT_SRAM

${hardware.defines.OOPSY_TARGET_USES_SDMMC ? `USE_FATFS = 1`:``}
# Optimize (i.e. CFLAGS += -O3):
OPT = -O3
# Core location, and generic Makefile.
SYSTEM_FILES_DIR = $(LIBDAISY_DIR)/core
include $(SYSTEM_FILES_DIR)/Makefile
# Include the rnbo lib
CFLAGS+=-I"${posixify_path(path.relative(build_path, rnboLibPath))}"
# Silence irritating warnings:
CFLAGS+=-O3 -Wno-unused-but-set-variable -Wno-unused-parameter -Wno-unused-variable
CPPFLAGS+=-O3 -Wno-unused-but-set-variable -Wno-unused-parameter -Wno-unused-variable

`, "utf-8");

	console.log(`Will ${action} from ${cpps.join(", ")} by writing to:`)
	console.log(`\t${maincpp_path}`)
	console.log(`\t${makefile_path}`)
	console.log(`\t${bin_path}`)
	
	// add watcher
	if (watch && watchers.length < 1) {
		watchers = cpps.map(cpp_path => fs.watch(cpp_path, (event, filepath)=>{
			run(...args);
		}))
	}

	apps.map(app => {
		generate_app(app, hardware, target, config);
		return app;
	})

	// store for debugging:
	//if (options.writejson) fs.writeFileSync(path.join(build_path, `${build_name}_${target}.json`), JSON.stringify(config,null,"  "),"utf8");

	const cppcode = `
/* 

This code was generated by Oopsy (https://github.com/electro-smith/oopsy) on ${new Date().toString()}

Oopsy was authored in 2020-2021 by Graham Wakefield and adapted to RNBO by Stefan Brunner.  Copyright 2021 Electrosmith, Corp., Graham Wakefield and Stefan Brunner.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
/*
	For details of the licensing terms of code exported from RNBO see https://support.cycling74.com/hc/en-us/articles/10730637742483-RNBO-Export-Licensing-FAQ
*/
${Object.keys(hardware.defines).map(k=>`
#define ${k} (${hardware.defines[k]})`).join("")}
${hardware.struct}

${hardware.inserts.filter(o => o.where == "header").map(o => o.code).join("\n")}

#define RNBO_USE_FLOAT32
#define RNBO_NOTHROW
#define RNBO_NOSTL
#define RNBO_FIXEDLISTSIZE 64
#define RNBO_USECUSTOMALLOCATOR

#include "../rnbo_daisy.h"

${apps.map(app => `#include "${posixify_path(path.relative(build_path, app.path))}"`).join("\n")}
${apps.map(app => app.cpp.struct).join("\n")}

// store apps in a union to re-use memory, since only one app is active at once:
union {
	${apps.map(app => app.cpp.union).join("\n\t")}
} apps;

oopsy::AppDef appdefs[] = {
	${apps.map(app => app.cpp.appdef).join("\n\t")}
};

int main(void) {
	#ifdef OOPSY_TARGET_PATCH_SM
	oopsy::daisy.hardware.Init(); 
	#else
  oopsy::daisy.hardware.Init(${options.boost|false}); 
	#endif
	oopsy::daisy.hardware.SetAudioSampleRate(daisy::SaiHandle::Config::SampleRate::SAI_${hardware.samplerate}KHZ);
	oopsy::daisy.hardware.SetAudioBlockSize(${hardware.defines.OOPSY_BLOCK_SIZE});
	${hardware.inserts.filter(o => o.where == "init").map(o => o.code).join("\n\t")}
	// insert custom hardware initialization here
	return oopsy::daisy.run(appdefs, ${apps.length});
}
`
	fs.writeFileSync(maincpp_path, cppcode, "utf-8");	

	console.log("oopsy generated code")

	// now try to make:
	try {
		console.log("oopsy compiling...")
		if (os.platform() == "win32") {
			// Don't use `make clean`, as `rm` is not default on Windows
			// /Q suppresses the Y/n prompt
			console.log(execSync("del /Q build", { cwd: build_path }).toString())
			// Gather up make output to run command per line as child process
			let build_cmd = execSync("make -n", { cwd: build_path }).toString().split(os.EOL)
			build_cmd.forEach(line => {
				// Silently execute the commands line-by-line.
				if (line.length > 0)
					execSync(line, { cwd: build_path }).toString()
			})
			console.log(`oopsy created binary ${Math.ceil(fs.statSync(posixify_path(path.join(build_path, "build", build_name+".bin")))["size"]/1024)}KB`)
			// if successful, try to upload to hardware:
			if (has_dfu_util && action=="upload") {
				console.log("oopsy flashing...")
				
				exec(`make program-dfu`, { cwd: build_path }, (err, stdout, stderr)=>{
					console.log("stdout", stdout)
					console.log("stderr", stderr)
					if (err) {
						if (err.message.includes("No DFU capable USB device available")) {
							console.log("oopsy daisy not ready on USB")
							return;
						} else if (err.message.includes("Last page at") && err.message.includes("is not writeable")) {
							console.log("bootloader is missing or in unresponsive state, please follow the HowTo to flash it first. (or just go to the Advanced Section of https://electro-smith.github.io/Programmer/)")
						} else if (stdout.includes("File downloaded successfully")) {
							console.log("oopsy flashed")
						} else {
							console.log("oopsy dfu error")
							console.log(err.message);
							return;
						}
					} else if (stderr) {
						// ignore these, it is a well known DFU export error
						stderr = stderr.replace("dfu-util: Warning: Invalid DFU suffix signature\n", "");
						stderr = stderr.replace("dfu-util: A valid DFU suffix will be required in a future dfu-util release\n", "");

						if (stderr.length) {
							console.log("oopsy dfu error")
							console.log(stderr);
							return;	
						}
						else {
							console.log("oopsy flashed")
						}
					}
				});
			}
		} else {
			exec(`export PATH=$PATH:${build_tools_path} && make clean && make`, { cwd: build_path }, (err, stdout, stderr)=>{
				if (err) {
					console.log("oopsy compiler error")
					console.log(err);
					console.log(stderr);
					return;
				}
				console.log(`oopsy created binary ${Math.ceil(fs.statSync(posixify_path(path.join(build_path, "build", build_name+".bin")))["size"]/1024)}KB`)
				// if successful, try to upload to hardware:
				if (has_dfu_util && action=="upload") {
					console.log("oopsy flashing...")
					exec(`export PATH=$PATH:${build_tools_path} && make program-dfu`, { cwd: build_path }, (err, stdout, stderr)=>{
						console.log("stdout", stdout)
						console.log("stderr", stderr)
						if (err) {
							if (err.message.includes("No DFU capable USB device available")) {
								console.log("oopsy daisy not ready on USB")
								return;
							} else if (err.message.includes("Last page at") && err.message.includes("is not writeable")) {
								console.log("bootloader is missing or in unresponsive state, please follow the HowTo to flash it first. (or just go to the Advanced Section of https://electro-smith.github.io/Programmer/)")
							} if (stdout.includes("File downloaded successfully")) {
								console.log("oopsy flashed")
							} else {
								console.log("oopsy dfu error")
								console.log(err.message);
								return;
							}
						} else if (stderr) {
							// ignore these, it is a well known DFU export error
							stderr = stderr.replace("dfu-util: Warning: Invalid DFU suffix signature\n", "");
							stderr = stderr.replace("dfu-util: A valid DFU suffix will be required in a future dfu-util release\n", "");

							if (stderr.length) {
								console.log("oopsy dfu error")
								console.log(stderr);
								return;	
							}
							else {
								console.log("oopsy flashed")
							}
						}
					});
				}
			});
		}
	} catch (e) {
		// errors from make here
		console.log("oopsy build failed", e);
	}
}

function analyze_json(jsonstr, hardware, desc_path) 
{
	let desc = JSON.parse(jsonstr);
	let rnbo = {
		name: desc.meta.rnboobjname,
		ins: [],
		outs: [],
		params: [],
		datas: []
	};

	desc.inlets.forEach(inlet => {
		if (inlet.type == "signal") {
			rnbo.ins.push(inlet.tag);
		}
		else {
			console.log("Non Signal inlets not supported, ignoring.")
		}
	});

	desc.outlets.forEach(outlet => {
		if (outlet.type == "signal") {
			rnbo.outs.push(outlet.tag);
		}
		else {
			console.log("Non Signal outlets not supported, ignoring.")
		}
	});

	desc.parameters.forEach(param => {
		if (param.visible) {
			let paramdesc = {
				name: param.name,
				cindex: param.index,
				default: param.initialValue,
				min: param.minimum,
				max: param.maximum
			};
	
			rnbo.params.push(paramdesc);	
		}
	});

	return rnbo;
}

function generate_daisy(hardware, nodes) {
	let daisy = {
		// DEVICE INPUTS:
		device_inputs: Object.keys(hardware.inputs).map(v => {
			let name = v
			nodes[name] = Object.assign({
				name: name,
				to: [],
			}, hardware.inputs[v])
			return name;
		}),

		datahandlers: Object.keys(hardware.datahandlers).map(name => {
			nodes[name] = Object.assign({
				name: name,
				data: null,
			}, hardware.datahandlers[name])
			return name;
		}),

		// DEVICE OUTPUTS:
		device_outs: Object.keys(hardware.outputs).map(name => {
			nodes[name] = {
				name: name,
				config: hardware.outputs[name],
				from: [],
			}
			return name;
		}),
		// configured below
		audio_ins: [],
		audio_outs: [],
	}
	let input_count = hardware.defines.OOPSY_IO_COUNT;
	let output_count = hardware.defines.OOPSY_IO_COUNT;
	for (let i=0; i<input_count; i++) {
		let name = `dsy_in${i+1}`
		nodes[name] = {
			name: name,
			to: [],
		}
		daisy.audio_ins.push(name);
	}
	for (let i=0; i<output_count; i++) {
		let name = `dsy_out${i+1}`
		nodes[name] = {
			name: name,
			to: [],
		}
		daisy.audio_outs.push(name);
	}
	
	if (hardware.defines.OOPSY_TARGET_HAS_MIDI_INPUT) {
		let name = `dsy_midi_in`
		nodes[name] = {
			name: name,
			to: [],
		}
		daisy.midi_ins = [name]
	} else {
		daisy.midi_ins = []
	}
	if (hardware.defines.OOPSY_TARGET_HAS_MIDI_OUTPUT) {
		let name = `dsy_midi_out`
		nodes[name] = {
			name: name,
			from: [],
		}
		daisy.midi_outs = [name]
	} else {
		daisy.midi_outs = []
	}
	return daisy
}

function generate_app(app, hardware, target, config) {
	const defines = hardware.defines
	const nodes = {}
	const daisy = generate_daisy(hardware, nodes, target);
	const rnbo = {}
	const name = app.patch.name;

	app.audio_outs = []
	app.midi_outs = []
	app.midi_noteouts = []
	app.has_midi_in = true
	app.has_generic_midi_in = true
	app.has_midi_out = true
	app.midi_out_count = 1;
	app.nodes = nodes;
	app.daisy = daisy;
	app.rnbo = rnbo;
	app.nodes = nodes;
	app.inserts = [];

	rnbo.audio_ins = app.patch.ins.map((s, i)=>{
		let name = "rnbo_in"+(i+1)
		let label = s.replace(/"/g, "").trim();
		let src = null;
		if (daisy.audio_ins.length > 0) {
			src = daisy.audio_ins[i % daisy.audio_ins.length];
		}
		nodes[name] = {
			// name: name,
			label: label,
			// index: i,
			src: src,
		}
		if (src) {
			nodes[src].to.push(name)
		}
		return name;
	})


	rnbo.audio_outs = app.patch.outs.map((s, i)=>{
		let name = "rnbo_out"+(i+1)
		let label = s.replace(/"/g, "").trim();
		let src = daisy.audio_outs[i];
		if (!src) {
			// create a glue node buffer for this:
			src = `glue_out${i+1}`
			nodes[src] = {
				// name: name,
				// kind: "output_buffer",
				// index: i,
				//label: s,
				to: [],
			}
			app.audio_outs.push(src);
		}
		
		let node = {
			name: name,
			// label: label,
			// index: i,
			src: src,
		}
		nodes[name] = node

		// figure out if the out buffer maps to anything:

		// search for a matching [out] name / prefix:
		let map
		let maplabel
		Object.keys(hardware.labels.outs).sort().forEach(k => {
			let match
			if (match = new RegExp(`^${k}_?(.+)?`).exec(label)) {
				map = hardware.labels.outs[k];
				maplabel = match[1] || label
			}
		})

		if (map) {
			label = maplabel
		} else {
			// else it is audio data			
			nodes[src].src = src;
		}
		nodes[name].label = label
		// was this out mapped to something?
		if (map) {
			nodes[map].from.push(src);
			nodes[src].to.push(map)
		}
		return name;
	})

	rnbo.params = app.patch.params.map((param, i)=>{
		const varname = "rnbo_param_"+ param.name + "_" + param.cindex;
		let src, label=param.name, type="float";

		let node = Object.assign({
			varname: varname,
		}, param);

		// figure out parameter range:
		node.max = node.max || 1;
		node.min = node.min || 0;
		node.default = node.default || 0;
		node.range = node.max - node.min;

		// search for a matching [out] name / prefix:
		Object.keys(hardware.labels.params).sort().forEach(k => {
			if (match = new RegExp(`^${k}_?(.+)?`).exec(param.name)) {
				src = hardware.labels.params[k];
				label = match[1] || param.name

				// search for any type qualifiers:
				//if (match = label.match(/^((.+)_)?(int|bool)(_(.*))?$/)) {
				if (match = label.match(/^(int|bool)(_(.*))?$/)) {
					//type = match[3];
					type = match[1]
					// trim type from label:
					//label = (match[2] || "") + (match[5] || "") 
					label = match[3] || label
				}
			}
		})

		node.type = type;
		node.src = src;
		node.label = label;

		let ideal_steps = 100 // about 4 good twists of the encoder
		if (node.type == "bool" || node.type == "int") {
			node.stepsize = 1
		} else {
			// figure out a suitable encoder step division for this parameter
			if (node.range > 2 && Number.isInteger(node.max) && Number.isInteger(node.max) && Number.isInteger(node.default)) {
				if (node.range < 10) {
					// might be v/oct
					node.stepsize = 1/12
				} else {
					// find a suitable subdivision:
					let power = Math.round(Math.log2(node.range / ideal_steps))
					node.stepsize = Math.pow(2, power)
				}
			} 
		}
		if (!node.stepsize) {
			// general case:
			node.stepsize = node.range / ideal_steps
		}
		
		nodes[varname] = node;
		if (src && nodes[src]) {
			nodes[src].to.push(varname)
		}
		return varname;
	})

	rnbo.datas = app.patch.datas.map((param, i)=>{
		const varname = "gen_data_"+param.name;
		let src, label;
		// search for a matching [out] name / prefix:
		Object.keys(hardware.labels.datas).sort().forEach(k => {
			let match
			if (match = new RegExp(`^${k}_?(.+)?`).exec(param.name)) {
				src = hardware.labels.datas[k];
				label = match[1] || param.name
			}
		})

		let node = Object.assign({
			varname: varname,
			label: param.name,
		}, param);
		nodes[varname] = node;

		if (src) {
			nodes[src].data = "rnbo." + param.cname;
			//nodes[src].to.push(varname)
			//nodes[src].from.push(src);
		}

		return varname;
	})

	if ((app.has_midi_in && hardware.defines.OOPSY_TARGET_HAS_MIDI_INPUT) || (app.has_midi_out && hardware.defines.OOPSY_TARGET_HAS_MIDI_OUTPUT)) {
		if (config.midiuse == "usb") {
			defines.OOPSY_TARGET_USES_MIDI_USB = 1
		}
		else if (config.midiuse == "uart") {
			defines.OOPSY_TARGET_USES_MIDI_UART = 1
		}	
	}

	// fill all my holes
	// map unused cvs/knobs to unmapped params?
	let upi=0; // unused param index
	let param = rnbo.params[upi];
	Object.keys(hardware.inputs).forEach(name => {
		const node = nodes[name];
		if (node.to.length == 0 && node.automap) {
			//console.log(name, "not mapped")
			// find next param without a src:
			while (param && !!nodes[param].src) param = rnbo.params[++upi];
			if (param) {
				//console.log(name, "map to", param)
				nodes[param].src = name;
				node.to.push(param);
			}
		}
	})

	// normal any audio outs from earlier (non cv/gate/midi) audio outs
	{
		let available = []
		daisy.audio_outs.forEach((name, i)=>{
			const node = nodes[name];
			// does this output have an audio source?
			if (node.src) {
				available.push(name);
			} else if (available.length) {
				node.src = available[i % available.length];
			}
		});
	}

	const struct = `

struct App_${name} : public oopsy::App<App_${name}> {
	${rnbo.params
		.map(name=>`
	${nodes[name].type} ${name};`).join("")}
	${rnbo.audio_outs
		.map(name=>nodes[name])
		.filter(node => node && node.midi_type).map(node=>
			`${node.type} ${node.varname};`).join("")}
	${daisy.device_outs
		.map(name => nodes[name])
		.filter(node => node.src || node.from.length)
		.map(node=>
			`float ${node.name};`).join("")}
	${app.audio_outs
		.map(name=>
			`float ${name}[OOPSY_BLOCK_SIZE];`).join("")}

	void init(oopsy::RNBODaisy& daisy) {
		rnbo = new RNBO::${name}<>();
		daisy.rnbo = rnbo;

		// initialize RNBO, here for example audio samples are allocated in the SDRAM (through our allocator)
		rnbo->initialize();

		// if you do not want this to allocate (and a slightly better performance) consider exporting your code
		// with a fixed audio vector size matching the one you are using (vectorsize)
		#ifdef OOPSY_TARGET_PATCH_SM
		rnbo->prepareToProcess(daisy.hardware.AudioSampleRate(), daisy.hardware.AudioBlockSize(), true);
		#else
		rnbo->prepareToProcess(daisy.hardware.seed.AudioSampleRate(), daisy.hardware.seed.AudioBlockSize(), true);
		#endif
		
		daisy.param_count = ${rnbo.params.length};
		${(defines.OOPSY_HAS_PARAM_VIEW) ? `daisy.param_selected = ${Math.max(0, rnbo.params.map(name=>nodes[name].src).indexOf(undefined))};`:``}
		${rnbo.params.map(name=>nodes[name])
			.map(node=>`
		${node.varname} = ${asCppNumber(node.default, node.type)};`).join("")}
		${daisy.device_outs.map(name => nodes[name])
			.filter(node => node.src || node.from.length)
			.map(node=>`
		${node.name} = 0.f;`).join("")}
		${daisy.datahandlers.map(name => nodes[name])
			.filter(node => node.init)
			.filter(node => node.data)
			.map(node =>`
		${interpolate(node.init, node)};`).join("")}
		${rnbo.datas.map(name=>nodes[name])
			.filter(node => node.wavname)
			.map(node=>`
		daisy.sdcard_load_wav("${node.wavname}", rnbo.${node.cname});`).join("")}
	}

	void audioCallback(oopsy::RNBODaisy& daisy, daisy::AudioHandle::InputBuffer hardware_ins, daisy::AudioHandle::OutputBuffer hardware_outs, size_t size) {
		Daisy& hardware = daisy.hardware;
		${app.inserts.concat(hardware.inserts).filter(o => o.where == "audio").map(o => o.code).join("\n\t")}
		${daisy.device_inputs.map(name => nodes[name])
			.filter(node => node.to.length)
			.filter(node => node.update && node.update.where == "audio")
			.map(node=>`
		${interpolate(node.update.code, node)};`).join("")}
		${daisy.device_inputs.map(name => nodes[name])
			.filter(node => node.to.length)
			.map(node=>`
		float ${node.name} = ${node.code};`).join("")}
		${rnbo.params
			.map(name=>nodes[name])
			.filter(node => node.src)
			.filter(node => node.where == "audio" || node.where == undefined)
			.map(node=>`
		${node.varname} = setParamIfChanged(${node.cindex},  ${node.varname}, (${node.type})(${node.src}*${asCppNumber(node.range)} + ${asCppNumber(node.min + (node.type == "int" || node.type == "bool" ? 0.5 : 0))}));`).join("")}
		${daisy.audio_ins.map((name, i)=>`
		float * ${name} = (float *)hardware_ins[${i}];`).join("")}
		${daisy.audio_outs.map((name, i)=>`
		float * ${name} = hardware_outs[${i}];`).join("")}
		// ${rnbo.audio_ins.map(name=>nodes[name].label).join(", ")}:
		float * inputs[] = { ${rnbo.audio_ins.map(name=>nodes[name].src).join(", ")} }; 
		// ${rnbo.audio_outs.map(name=>nodes[name].label).join(", ")}:
		float * outputs[] = { ${rnbo.audio_outs.map(name=>nodes[name].src).join(", ")} };
		rnbo->process(inputs, ${rnbo.audio_ins.length}, outputs, ${rnbo.audio_outs.length}, size);
		${daisy.device_outs.map(name => nodes[name])
			.filter(node => node.src || node.from.length)
			.map(node => node.src ? `
		${node.name} = ${node.src};` : `
		${node.name} = ${node.from.map(name=>name+"[ size-1]").join(" + ")}; // device out`).join("")}
		${daisy.device_outs.map(name => nodes[name])
			.filter(node => node.src || node.from.length)
			.filter(node => node.config.where == "audio")
			.map(node=>`
		${interpolate(node.config.code, node)} // set out`).join("")}
		${daisy.datahandlers.map(name => nodes[name])
			.filter(node => node.where == "audio")
			.filter(node => node.data)
			.map(node =>`
		${interpolate(node.code, node)} // data out`).join("")}	
		// msgs: ${(app.midi_outs.filter(node=>node.midi_throttle).length + app.midi_noteouts.filter(note=>note.press).length)}
		// rate: ${hardware.defines.OOPSY_BLOCK_RATE/500}
		${daisy.audio_outs.map(name=>nodes[name])
			.filter(node => node.src != node.name)
			.map(node=>node.src ? `
		memcpy(${node.name}, ${node.src}, sizeof(float)*size);` : `
		memset(${node.name}, 0, sizeof(float)*size);`).join("")}
		${app.inserts.concat(hardware.inserts).filter(o => o.where == "post_audio").map(o => o.code).join("\n\t")}
		${hardware.defines.OOPSY_TARGET_SEED ? "hardware.PostProcess();" : ""}
	}	

	void mainloopCallback(oopsy::RNBODaisy& daisy, uint32_t t, uint32_t dt) {
		Daisy& hardware = daisy.hardware;
		${app.inserts.concat(hardware.inserts).filter(o => o.where == "main").map(o => o.code).join("\n\t")}
		${daisy.datahandlers.map(name => nodes[name])
			.filter(node => node.where == "main")
			.filter(node => node.data)
			.map(node =>`
		${interpolate(node.code, node)}`).join("")}
		${daisy.device_outs.map(name => nodes[name])
			.filter(node => node.src || node.from.length)
			.filter(node => node.config.where == "main")
			.map(node=>`
		${interpolate(node.config.code, node)}`).join("")}
	}

	void displayCallback(oopsy::RNBODaisy& daisy, uint32_t t, uint32_t dt) {
		Daisy& hardware = daisy.hardware;
		${app.inserts.concat(hardware.inserts).filter(o => o.where == "display").map(o => o.code).join("\n\t")}
		${daisy.datahandlers.map(name => nodes[name])
			.filter(node => node.where == "display")
			.filter(node => node.data)
			.map(node =>`
		${interpolate(node.code, node)}`).join("")}
		${daisy.device_outs.map(name => nodes[name])
			.filter(node => node.src || node.from.length)
			.filter(node => node.config.where == "display")
			.map(node=>`
		${interpolate(node.config.code, node)}`).join("")}
		${hardware.defines.OOPSY_TARGET_SEED ? "hardware.Display();" : ""}
	}

	${defines.OOPSY_HAS_PARAM_VIEW ? `
	float setparam(int idx, float val) {
		switch(idx) {
			${rnbo.params
				.map(name=>nodes[name])
				.map((node, i)=>`
			case ${i}: return ${node.varname} = (${node.type})(val > ${asCppNumber(node.max, node.type)}) ? ${asCppNumber(node.max, node.type)} : (val < ${asCppNumber(node.min, node.type)}) ? ${asCppNumber(node.min, node.type)} : val;`).join("")}
		}
		return 0.f;	
	}

	${defines.OOPSY_TARGET_HAS_OLED && defines.OOPSY_HAS_PARAM_VIEW ? `
	void paramCallback(oopsy::RNBODaisy& daisy, int idx, char * label, int len, bool tweak) {
		switch(idx) { ${rnbo.params.map(name=>nodes[name]).map((node, i)=>`
		case ${i}: ${defines.OOPSY_CAN_PARAM_TWEAK ? `
		if (tweak) setparam(${i}, ${node.varname} + daisy.menu_button_incr ${node.type == "float" ? '* ' + asCppNumber(node.stepsize, node.type) : ""});` : ""}
		${defines.OOPSY_OLED_DISPLAY_WIDTH < 128 ? `snprintf(label, len, "${node.label.substring(0,5).padEnd(5," ")}" FLT_FMT3 "", FLT_VAR3(${node.varname}) );` : `snprintf(label, len, "${node.src ? 
			`${node.src.substring(0,3).padEnd(3," ")} ${node.label.substring(0,11).padEnd(11," ")}" FLT_FMT3 ""` 
			: 
			`%s ${node.label.substring(0,11).padEnd(11," ")}" FLT_FMT3 "", (daisy.param_is_tweaking && ${i} == daisy.param_selected) ? "enc" : "   "`
			}, FLT_VAR3(${node.varname}) );`}
		break;`).join("")}
		}	
	}
	` : ""}
	` : ""}
};`
	app.cpp = {
		union: `App_${name} app_${name};`,
		appdef: `{"${name}", []()->void { oopsy::daisy.reset(apps.app_${name}); } },`,
		struct: struct,
	}
	return app
}
