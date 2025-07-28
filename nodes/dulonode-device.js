module.exports = function (RED) {
    function DuloNodeDevice(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.on('input', function (msg) {   
            const status = msg.payload.status || '';
            const deviceId = node.id;

            // Check if the current node's ID is in the devices array
            if (status === 'deployed') {
                const devices = msg.payload.devices || [];

                if (devices.includes(deviceId)) {
                    // Device is online, set status to green
                    node.status({ fill: 'green', shape: 'dot', text: '' });
                } else {
                    // Device is limited, set status to grey
                    node.status({ fill: 'grey', shape: 'ring', text: 'paid only' });
                }
            }

            if (msg.payload.id == deviceId) {
                node.send(msg);
            }
        });
    }

    RED.nodes.registerType("DuloNodeDevice", DuloNodeDevice);
};
