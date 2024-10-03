const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const fs = require("fs");

module.exports = {
    // returns the path `str` with posix path formatting:
    posixify_path: function (str) {
        return str.split(path.sep).join(path.posix.sep);
    },

    // returns str with any $<key> replaced by data[key]
    interpolate: function (str, data) {
        return str.replace(/\$<([^>]+)>/gm, (s, key) => data[key])
    },

    template: (template, vars = {}) => {
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
    },

    // prints a number as a C-style float:
    asCppNumber: function (n, type = "float") {
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
    },

    checkBuildEnvironment: function() {
        let build_tools_path;
        let has_dfu_util;

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

        return [ build_tools_path, has_dfu_util ]
    },

    help: `
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
`,

    component_defs: {
        Switch: {
            typename: "daisy::Switch",
            pin: "a",
            type: "daisy::Switch::TYPE_MOMENTARY",
            polarity: "daisy::Switch::POLARITY_INVERTED",
            pull: "daisy::Switch::PULL_UP",
            process: "${name}.Debounce();",
            updaterate: "${name}.SetUpdateRate(seed.AudioCallbackRate());",
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
            updaterate: "${name}.SetUpdateRate(seed.AudioCallbackRate());",
            mapping: [
                {
                    name: "${name}",
                    get: "(hardware.${name}.Increment()*0.5f+0.5f)",
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
            slew: "1.0/seed.AudioCallbackRate()",
            process: "${name}.Process();",
            updaterate: "${name}.SetSampleRate(seed.AudioCallbackRate());",
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
                    set: "hardware.seed.dac.WriteValue(daisy::DacHandle::Channel::ONE, $<name> * 4095);",
                    where: "main"
                },
                {
                    name: "${name}2",
                    set: "hardware.seed.dac.WriteValue(daisy::DacHandle::Channel::TWO, $<name> * 4095);",
                    where: "main"
                }
            ]
        }
    },

    // generate the struct
    generate_target_struct: function(target) {
        
        // flesh out target components:
        let components = Object.entries(target.components)
        .sort((a, b) =>
            a[1].component < b[1].component
            ? -1
            : a[1].component > b[1].component
            ? 1
            : 0
        )
        .map((pair) => {
            let [name, def] = pair;
            def.name = name;
            let component = component_defs[def.component];
            if (component) {
            // copy component defaults into the def
            // TODO this should be recursive for object structures...
            for (let k of Object.keys(component)) {
                if (def[k] == undefined) def[k] = component[k];
            }
            } else {
            throw new Error("undefined component kind: " + def.component);
            }
            return def;
        });
        target.components = components;
        target.name = target.name || "custom"

        if (target.display) {
            // apply defaults:
            target.display = Object.assign({
                driver: "daisy::SSD130x4WireSpi128x64Driver",
                config: [],
                dim: [128, 64]
            }, target.display)
            target.defines.OOPSY_TARGET_HAS_OLED = 1
            target.defines.OOPSY_OLED_DISPLAY_WIDTH = target.display.dim[0]
            target.defines.OOPSY_OLED_DISPLAY_HEIGHT = target.display.dim[1]
        }
    
        return `
    #include "daisy_seed.h"
    ${target.display ? `#include "dev/oled_ssd130x.h"` : ""}
    // name: ${target.name}
    struct Daisy {
    
        void Init(bool boost = false) {
            seed.Configure();
            seed.Init(boost);
            ${components.filter((e) => e.init)
            .map((e) => `
            ${template(e.init, e)}`
            ).join("")}
            ${components.filter((e) => e.typename == "daisy::Switch")
            .map((e, i) => `
            ${e.name}.Init(seed.GetPin(${e.pin}), seed.AudioCallbackRate(), ${e.type}, ${e.polarity}, ${e.pull});`
            ).join("")}
            ${components.filter((e) => e.typename == "daisy::Switch3").map((e, i) => `
            ${e.name}.Init(seed.GetPin(${e.pin.a}), seed.GetPin(${e.pin.b}));`
            ).join("")}
            ${components.filter((e) => e.typename == "daisy::GateIn").map((e, i) => `
            dsy_gpio_pin ${e.name}_pin = seed.GetPin(${e.pin});
            ${e.name}.Init(&${e.name}_pin);`
            ).join("")}
            ${components.filter((e) => e.typename == "daisy::Encoder").map((e, i) => `
            ${e.name}.Init(seed.GetPin(${e.pin.a}), seed.GetPin(${e.pin.b}), seed.GetPin(${e.pin.click}), seed.AudioCallbackRate());`
            ).join("")}
            static const int ANALOG_COUNT = ${
            components.filter((e) => e.typename == "daisy::AnalogControl").length};
            daisy::AdcChannelConfig cfg[ANALOG_COUNT];
            ${components.filter((e) => e.typename == "daisy::AnalogControl").map((e, i) => `
            cfg[${i}].InitSingle(seed.GetPin(${e.pin}));`).join("")}
            seed.adc.Init(cfg, ANALOG_COUNT);
            ${components.filter((e) => e.typename == "daisy::AnalogControl").map((e, i) => `
            ${e.name}.Init(seed.adc.GetPtr(${i}), seed.AudioCallbackRate(), ${e.flip}, ${e.invert});`).join("")}
            ${components.filter((e) => e.typename == "daisy::Led").map((e, i) => `
            ${e.name}.Init(seed.GetPin(${e.pin}), ${e.invert});
            ${e.name}.Set(0.0f);`).join("")}	
            ${components.filter((e) => e.typename == "daisy::RgbLed").map((e, i) => `
            ${e.name}.Init(seed.GetPin(${e.pin.r}), seed.GetPin(${e.pin.g}), seed.GetPin(${e.pin.b}), ${e.invert});
            ${e.name}.Set(0.0f, 0.0f, 0.0f);`).join("")}
            ${components.filter((e) => e.typename == "daisy::dsy_gpio").map((e, i) => `
            ${e.name}.pin  = seed.GetPin(${e.pin});
            ${e.name}.mode = ${e.mode};
            ${e.name}.pull = ${e.pull};
            dsy_gpio_init(&${e.name});`).join("")}
            ${components.filter((e) => e.typename == "daisy::DacHandle::Config").map((e, i) => `
            ${e.name}.bitdepth   = ${e.bitdepth};
            ${e.name}.buff_state = ${e.buff_state};
            ${e.name}.mode       = ${e.mode};
            ${e.name}.chn        = ${e.channel};
            seed.dac.Init(${e.name});
            seed.dac.WriteValue(${e.channel}, 0);`).join("")}
            ${target.display ? `
            daisy::OledDisplay<${target.display.driver}>::Config display_config;
            display_config.driver_config.transport_config.Defaults(); ${(target.display.config || []).map(e=>`
            ${e}`).join("")}
            display.Init(display_config);`:`// no display`}
        }
    
        void ProcessAllControls() {
            ${components.filter((e) => e.process).map((e) => `
            ${template(e.process, e)}`).join("")}
            ${components.filter((e) => e.meta).map((e) => e.meta.map(m=>`
            ${template(m, e)}`).join("")).join("")}
        }
        
        void PostProcess() {
            ${components.filter((e) => e.postprocess).map((e) => `
            ${template(e.postprocess, e)}`).join("")}
        }
        
        void Display() {
            ${components.filter((e) => e.display).map((e) => `
            ${template(e.display, e)}`).join("")}
        }
    
        void SetAudioSampleRate(daisy::SaiHandle::Config::SampleRate samplerate) {
            seed.SetAudioSampleRate(samplerate);
            SetHidUpdateRates();
        }

        void SetAudioBlockSize(size_t size) {
            seed.SetAudioBlockSize(size);
            SetHidUpdateRates();
        }

        void SetHidUpdateRates() {
            ${components.filter((e) => e.updaterate).map((e) => `
            ${template(e.updaterate, e)}`).join("")}
        }
    
        daisy::DaisySeed seed;
        ${components.map((e) => `
        ${e.typename} ${e.name};`).join("")}
        ${target.display ? `daisy::OledDisplay<${target.display.driver}> display;`:`// no display`}
        int menu_click = 0, menu_hold = 0, menu_rotate = 0;

    };`;
    }
};
