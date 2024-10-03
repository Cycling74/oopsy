const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

const json2daisy = require(path.join(__dirname, "json2daisy.js"));
const daisy_glue = require(path.join(__dirname, "daisy_glue.js"));

// returns the path `str` with posix path formatting:
function posixify_path(str) {
	return str.split(path.sep).join(path.posix.sep);
}

// returns str with any $<key> replaced by data[key]
function interpolate(str, data) {
	return str.replace(/\$<([^>]+)>/gm, (s, key) => data[key])
}

const template = (template, vars = {}) => {
	const handler = new Function(
	  "vars",
	  [
		"const f = (" + Object.keys(vars).join(", ") + ")=>",
		"`" + template + "`",
		"return f(...Object.values(vars))"
	  ].join("\n")
	);
	// console.log(Object.keys(vars));
	// console.log(handler);
	return handler(vars);
};

// prints a number as a C-style float:
function asCppNumber(n, type="float") {
	let s = (+n).toString();
	if (type == "int" || type == "uint8_t" || type == "bool") {
		return Math.trunc(n).toString()
	} else {
		// add point if needed:
		if (s.includes("e")) {
			return s;
		} else if (s.includes(".")) {
			return s + "f";
		} else {
			return s + ".f";
		}
	}
}

function node_scale(node) {
	if (node.permit_scale == false)
		return `${node.varname} = (${node.type})(${node.src});
		`
	else
		return `${node.varname} = (${node.type})(${node.src}*${asCppNumber(node.range)} + ${asCppNumber(node.min + (node.type == "int" || node.type == "bool" ? 0.5 : 0))});
		`
}

let build_tools_path;
let has_dfu_util;
function checkBuildEnvironment() {
	// check for available build tools:
	if (os.platform == "win32") {
		has_dfu_util = false;
		try {
			execSync("arm-none-eabi-gcc --version")
			execSync("dfu-util --version")
			// assume true for now, until we know how to test for it:
			has_dfu_util = true;
		} catch (e) {
			console.warn(`oopsy can't find the ARM GCC build tools, will not be able to upload binary to the Daisy. Please check https://github.com/electro-smith/DaisyWiki/wiki/1e.-Getting-Started-With-Oopsy-(Gen~-Integration) for installation instructions.`)
			process.exit(-1);
		}

	} else {
		// OSX:
		let locations = ["/opt/homebrew/bin", "/usr/local/bin"]
		for (loc of locations) {
			if (fs.existsSync(`${loc}/arm-none-eabi-gcc`)) {
				build_tools_path = loc;
				console.log(`using build tools found in ${build_tools_path}`);
				break;
			}
		}
		if (!build_tools_path) {
			console.log("oopsy can't find an ARM-GCC toolchain. Please check https://github.com/electro-smith/DaisyWiki/wiki/1e.-Getting-Started-With-Oopsy-(Gen~-Integration) for installation instructions.")
			process.exit(-1);
		}
		if (fs.existsSync(`${build_tools_path}/dfu-util`)) {
			has_dfu_util = true;
		} else {
			console.warn(`oopsy can't find the dfu-util binary in ${build_tools_path}, will not be able to upload binary to the Daisy. Please check https://github.com/electro-smith/DaisyWiki/wiki/1e.-Getting-Started-With-Oopsy-(Gen~-Integration) for installation instructions.`)
		}
	}
}

const help = `
<[cmds]> <target> <[options]> <[cpps]> <watch>

cmds: 	up/upload = (default) generate & upload
	  	gen/generate = generate only

target: path to a JSON for the hardware config,
		or simply "patch", "patch_sm", "field", "petal", "pod" etc.
		Defaults to "daisy.patch.json"

32kHz, 48kHz, "96kHz" will set the sampling rate of the binary

block1, block2, etc. up to block256 will set the block size

fastmath will replace some expensive math operations with faster approximations

boost will increase the CPU from 400Mhz to 480Mhz

nooled will disable code generration for OLED (it will be blank)

cpps: 	paths to the gen~ exported cpp files
		first item will be the default app

watch:	script will not terminate
		actions will be re-run each time any of the cpp files are modified
`

const component_defs = {
	Switch: {
		typename: "daisy::Switch",
		pin: "a",
		type: "daisy::Switch::TYPE_MOMENTARY",
		polarity: "daisy::Switch::POLARITY_INVERTED",
		pull: "daisy::Switch::PULL_UP",
		process: "${name}.Debounce();",
		updaterate: "${name}.SetUpdateRate(som.AudioCallbackRate());",
		mapping: [
			{ name: "${name}", get: "(hardware.${name}.Pressed()?1.f:0.f)", range: [0, 1] },
			{
				name: "${name}_rise",
				get: "(hardware.${name}.RisingEdge()?1.f:0.f)",
				range: [0, 1]
			},
			{
				name: "${name}_fall",
				get: "(hardware.${name}.FallingEdge()?1.f:0.f)",
				range: [0, 1]
			},
			{
				name: "${name}_seconds",
				get: "(hardware.${name}.TimeHeldMs()*0.001f)",
				range: null
			}
	  	]
	},
	Switch3: {
		typename: "daisy::Switch3",
		pin: "a,b",
		mapping: [
			{ name: "${name}", get: "(hardware.${name}.Read()*0.5f+0.5f)", range: [0, 2] }
		]
	},
	Encoder: {
		typename: "daisy::Encoder",
		pin: "a,b,click",
		process: "${name}.Debounce();",
		updaterate: "${name}.SetUpdateRate(som.AudioCallbackRate());",
		mapping: [
			{
				name: "${name}",
				get: "hardware.${name}.Increment()",
				range: [-1, 1]
			},
			{
				name: "${name}_press",
				get: "(hardware.${name}.Pressed()?1.f:0.f)",
				range: [0, 1]
			},
			{
				name: "${name}_rise",
				get: "(hardware.${name}.RisingEdge()?1.f:0.f)",
				range: [0, 1]
			},
			{
				name: "${name}_fall",
				get: "(hardware.${name}.FallingEdge()?1.f:0.f)",
				range: [0, 1]
			},
			{
				name: "${name}_seconds",
				get: "(hardware.${name}.TimeHeldMs()*0.001f)",
				range: null
			}
		]
	},
	GateIn: {
		typename: "daisy::GateIn",
		pin: "a",
		mapping: [
			{ name: "${name}", get: "(hardware.${name}.State()?1.f:0.f)", range: [0, 1] },
			{ name: "${name}_trig", get: "(hardware.${name}.Trig()?1.f:0.f)", range: [0, 1] }
		]
	},
	AnalogControl: {
		typename: "daisy::AnalogControl",
		pin: "a",
		flip: false,
		invert: false,
		slew: "1.0/som.AudioCallbackRate()",
		process: "${name}.Process();",
		updaterate: "${name}.SetSampleRate(som.AudioCallbackRate());",
		mapping: [{ name: "${name}", get: "(hardware.${name}.Value())", range: [0, 1] }]
	},
	Led: {
		typename: "daisy::Led",
		pin: "a",
		invert: true,
		postprocess: "${name}.Update();",
		mapping: [{ name: "${name}", set: "hardware.${name}.Set($<name>);" }]
	},
	RgbLed: {
		typename: "daisy::RgbLed",
		pin: "r,g,b",
		invert: true,
		postprocess: "${name}.Update();",
		mapping: [
			{ name: "${name}_red", set: "hardware.${name}.SetRed($<name>);" },
			{ name: "${name}_green", set: "hardware.${name}.SetGreen($<name>);" },
			{ name: "${name}_blue", set: "hardware.${name}.SetBlue($<name>);" },
			{ name: "${name}", set: "hardware.${name}.Set(clamp(-$<name>, 0.f, 1.f), 0.f, clamp($<name>, 0.f, 1.f));" },
			{ name: "${name}_white", set: "hardware.${name}.Set($<name>,$<name>,$<name>);" }
		]
	},
	GateOut: {
		typename: "daisy::dsy_gpio",
		pin: "a",
		mode: "DSY_GPIO_MODE_OUTPUT_PP",
		pull: "DSY_GPIO_NOPULL",
		mapping: [
			{ name: "${name}", set: "dsy_gpio_write(&hardware.${name}, $<name> } 0.f);" }
		]
	},
	CVOuts: {
		typename: "daisy::DacHandle::Config",
		pin: "",
		bitdepth: "daisy::DacHandle::BitDepth::BITS_12",
		buff_state: "daisy::DacHandle::BufferState::ENABLED",
		mode: "daisy::DacHandle::Mode::POLLING",
		channel: "daisy::DacHandle::Channel::BOTH",
		mapping: [
			{
				name: "${name}1",
				set: "hardware.som.dac.WriteValue(daisy::DacHandle::Channel::ONE, $<name> * 4095);",
				where: "main"
			},
			{
				name: "${name}2",
				set: "hardware.som.dac.WriteValue(daisy::DacHandle::Channel::TWO, $<name> * 4095);",
				where: "main"
			}
		]
	}
};


module.exports = {
    // returns the path `str` with posix path formatting:
    posixify_path: posixify_path,

    // returns str with any $<key> replaced by data[key]
    interpolate: interpolate,

    // prints a number as a C-style float:
    asCppNumber: asCppNumber,

    checkBuildEnvironment: checkBuildEnvironment,

    help: help
};
