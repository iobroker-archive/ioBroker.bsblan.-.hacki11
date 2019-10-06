"use strict";

/*
 * Created with @iobroker/create-adapter v1.16.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const BSB = require('./lib/bsb');

class Bsblan extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "bsblan",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // setup timer
        this.interval = this.config.interval || 60;
        this.interval *= 1000;
        if (this.interval < 10000)
            this.interval = 10000;

        this.bsb = new BSB(this.config.host, this.config.user, this.config.password);

        this.values = this.resolveConfigValues();


        // if (this.newValues.length !== 0) {
        //     this.log.info("New values found: " + [...this.newValues].sort());
        //     await this.initializeParameters(this.newValues);
        // }
        // // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates("*");

        this.update();
    }

    resolveConfigValues() {
        let values = new Set();
        for (let line of this.config.values.split(/\r?\n/)) {
            for (let entry of line.split(",")) {
                let value = entry.trim();
                if (isNaN(parseInt(value))) {
                    this.log.error(value + " is not a valid id to retrieve.")
                } else {
                    values.add(entry.trim());
                }
            }
        }
        let valuesArray = [...values].sort();
        this.log.info("Values found: " + valuesArray)
        return valuesArray;
    }

    update() {

        this.detectNewObjects(this.values)
            .then(newValues => this.initializeParameters(newValues))
            .then(() => this.connectionHandler(true))
            .then(() => this.bsb.query(this.values))
            .then(result => this.setStates(result))
            .then(() => this.refreshTimer())
            .catch((error) => {
                this.errorHandler(error);
                this.refreshTimer();
            });
    }

    refreshTimer() {
        this.timer = setTimeout(() => this.update(), this.interval);
    }

    async initializeParameters(values) {

        if (!values || values.size == 0) return;

        this.log.info("Setup new objects (" + [...values] + ") ...")
        this.categories = await this.bsb.categories();

        let categoryMap = {};

        for (let value of values) {
            for (let category of Object.keys(this.categories)) {
                if (value >= this.categories[category]['min'] && value <= this.categories[category]['max']) {
                    var obj = {
                        id: category,
                        native: this.categories[category],
                        values: []
                    };
                    if (!categoryMap[category]) {
                        categoryMap[category] = obj;
                    }
                    categoryMap[category].values.push(value);
                    break;
                }
            }
        }

        var values = await this.bsb.query(values);

        // let params = {};
        for (let category of Object.keys(categoryMap)) {
            this.log.info("Fetching category " + category + " " + categoryMap[category].native.name + " ...")
            await this.bsb.category(category)
                .then(result => this.setupCategory(categoryMap[category], result, values));
        }

        this.log.info("Setup objects done.")
    }

    detectNewObjects(values) {

        let newValues = new Set(values);
        return this.getAdapterObjectsAsync()
            .then(records => {
                for (let key of Object.keys(records)) {
                    let id = records[key].native.id;
                    if (newValues.has(id)) {
                        newValues.delete(id);
                    }
                }
                return newValues;
            });
    }

    setupCategory(category, params, values) {
        var name = category.native['name'] + " (" + category.native['min'] + " - " + category.native['max'] + ")";
        this.log.info("Setup category " + category.id + ": " + name);

        for (let value of category.values) {
            this.setupObject(value, params[value], values[value]);
        }
    }

    async setupObject(key, param, value) {
        let name = param.name + " (" + key + ")";

        this.log.info("Add Parameter: " + name);

        let obj = {
            type: "state",
            common: {
                name: name,
                type: this.mapType(param.dataType),
                role: "value",
                read: true,
                write: false,
                unit: this.parseUnit(value.unit),
                states: this.createObjectStates(param.possibleValues)
            },
            native: {
                id: key,
                bsb: param,
            }
        };
        this.setObjectNotExistsAsync(this.createId(key, param.name), obj)
            .then(this.setStateAsync(this.createId(key, param.name), {val: value.value, ack: true}))
            .catch((error) => this.errorHandler(error));
    }

    setStates(data) {
        for (let key of Object.keys(data)) {
            this.setStateAsync(this.createId(key, data[key].name), {val: data[key].value, ack: true})
                .catch((error) => this.errorHandler(error));
        }
    }

    createId(key, name) {
        return name.replace(/\s/g, "_").replace(/\./g, "") + "_(" + key + ")";
    }

    createObjectStates(possibleValues) {
        let states = {};
        for (let entry of possibleValues) {
            states[entry['enumValue']] = entry['desc']
        }
        return states;
    }

    mapType(type) {
        // https://1coderookie.github.io/BSB-LPB-LAN/kap08.html#824-abrufen-und-steuern-mittels-json
        switch (type) {
            case 0:
                return "number"; // number
            case 1:
                return "string"; // enum
            case 2:
                return "string"; // weekday
            case 3:
                return "number"; // hr/min
            case 4:
                return "string"; // date/time
            case 5:
                return "number"; // day/month
            case 6:
                return "string"; // string
            default:
                return "string";
        }
    }

    parseUnit(unit) {
        return unit
            .replace("&deg;", "°")
            .replace("&#037;", "%");
    }

    errorHandler(error) {
        this.log.error(error.message);
        if (error.stack)
            this.log.error(error.stack);
        this.connectionHandler(false);
    }

    connectionHandler(connected) {
        if (this.connection !== connected) {
            this.connection = connected;
            if (connected)
                this.log.info("Connection established successfully");
            else
                this.log.error("Connection failed");

            this.setState("info.connection", this.connection);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info("cleaned everything up...");
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            // this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            // this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

// /**
//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
//  * Using this method requires "common.message" property to be set to true in io-package.json
//  * @param {ioBroker.Message} obj
//  */
// onMessage(obj) {
// 	if (typeof obj === "object" && obj.message) {
// 		if (obj.command === "send") {
// 			// e.g. send email or pushover or whatever
// 			this.log.info("send command");

// 			// Send response in callback if required
// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
// 		}
// 	}
// }

}

// @ts-ignore parent is a valid property on module
if (module

    .parent
) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module
        .exports = (options) => new Bsblan(options);
} else {
    // otherwise start the instance directly
    new Bsblan();
}