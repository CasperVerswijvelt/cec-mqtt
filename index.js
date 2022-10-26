const mqtt = require('mqtt');
const spawn = require('child_process').spawn;
const fs = require('fs');

let config = {};
let cecClient = null;
let mqttClient = null;

const cmdQueue = { power: [] };
const lastState = {};
const lastPowerCmdTime = {};
const startTime = Date.now();

// Read config
try {
  config = JSON.parse(fs.readFileSync('config.json', { encoding: 'utf-8' }));
} catch (e) {
  console.error(`Failed to load config.json (${e})\nPlease ensure the file exists and is valid JSON.`);
  process.exit(1);
}

// Connect to MQTT
console.log('Attempting to connect to MQTT server');
mqttClient = mqtt.connect(config.mqttUrl);
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker')
  for (const id in config.idMap) {
    for (const subTopic of config.subTopics) {
      const topic = config.idMap[id].rootTopic + '/' + subTopic
      console.log('Subscribing to ' + topic);
      mqttClient.subscribe(topic);
    }
  }
});
mqttClient.on('message', (topic, message) => {
  console.log(' mqtt < ' + topic + ': ' + message.toString());
  if ((Date.now() - startTime) < 5000) {
    console.log('  Assuming MQTT update is from initial subscription, ignoring');
    return;
  }
  let id = 0
  for (id in config.idMap) {
    if (topic.indexOf(config.idMap[id].rootTopic) === 0) break;
  }
  const subTopic = topic.split('/')[topic.split('/').length - 1];

  switch (subTopic) {
    case 'power':
      if (
        (
          message.toString() === 'ON' || 
          message.toString() === 'OFF'
        ) && 
        lastState[id] !== message.toString()
      ) {
        console.log('turning ' + id + ' ' + message.toString());
        lastPowerCmdTime[id] = Date.now();
        switch (message.toString()) {
          case 'OFF':
            cecClient.stdin.write(`standby ${id}\n`);
            break;
          case 'ON':
            cecClient.stdin.write(`on ${id}\n`);
            break;
        }
      }
      break;
  }
});

// Setup CEC client
cecClient = spawn(config.cecClientCommand, config.cecClientArgs);
cecClient.stdout.on('data', (data) => {
  data.toString().split('\n')
    .map(line => line.trim())
    .forEach(line => {

    const hasPowerStatus = line.indexOf('power status: ') === 0;

    // Only log non-spammy cec client messages
    if (line && !hasPowerStatus) console.log(` cecClient < ${line}`);

    // Power status update
    if (
      config.subTopics.indexOf('power') !== -1 &&
      hasPowerStatus
    ) {
      const id = cmdQueue.power.shift(); // Get the first element from the array
      const reportedState = line.split(': ')[1];
      let state;
      switch (reportedState) {
        case 'in transition from standby to on':
        case 'on':
          state = 'ON';
          break;
        case 'unknown':
        case 'standby':
        default:
          state = 'OFF';
          break;
      }

      const timeDiff = Date.now() - (lastPowerCmdTime[id] || 0)

      if (
        lastState[id] !== state &&
        timeDiff > config.powerCmdWaitMs
      ) {
        const topic = `${config.idMap[id].rootTopic}/power`
        console.log(` mqtt > ${topic}: ${state}`);
        mqttClient.publish(topic , state, { retain: true });
      }
      lastState[id] = state;
    }
  })
});

// Periodic power check
if (config.subTopics.indexOf('power') !== -1) {
  setInterval(() => {
    Object.keys(config.idMap).forEach(async (id) => {
      cmdQueue.power.push(id);
      cecClient.stdin.write(`pow ${id}\n`);
    })
  }, config.powerCheckIntMs);
}