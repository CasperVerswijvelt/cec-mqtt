const mqtt = require('mqtt');
const spawn = require('child_process').spawn;
const fs = require('fs');

let config = {};
let cecClient = null;
let mqttClient = null;

const lastState = {};

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
  for (const id in config.topicMap) {
    const topic = config.topicMap[id].commandTopic
    console.log('Subscribing to ' + topic);
    mqttClient.subscribe(topic);
  }
});
mqttClient.on('message', (topic, message) => {
  console.log(' mqtt < ' + topic + ': ' + message.toString());
  let id = 0
  for (id in config.topicMap) {
    if (topic === config.topicMap[id].commandTopic) break;
  }

  if (
    (
      message.toString() === 'ON' ||
      message.toString() === 'OFF'
    ) &&
    lastState[id] !== message.toString()
  ) {
    console.log(` cecClient >  ${id}: ${message.toString()}`);
    switch (message.toString()) {
      case 'OFF':
        cecClient.stdin.write(`standby ${id}\n`);
        break;
      case 'ON':
        cecClient.stdin.write(`on ${id}\n`);
        break;
    }
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
      if (hasPowerStatus) {
        // TODO Get dynamic
        const id = "0"
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

        if (lastState[id] !== state) {
          console.log(` cecClient < ${line}`);
          const topic = config.topicMap[id].stateTopic
          console.log(` mqtt > ${topic}: ${state}`);
          mqttClient.publish(topic, state, { retain: true });
        }
        lastState[id] = state;
      }
    })
});

// Periodic power check
setInterval(() => {
  Object.keys(config.topicMap).forEach(async (id) => {
    cecClient.stdin.write(`pow ${id}\n`);
  })
}, config.powerCheckInterval);