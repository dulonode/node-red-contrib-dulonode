const { settings } = require('../settings.js')
const axios = require('axios');
const mqtt = require('mqtt');
const { CognitoIdentityProviderClient, InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');

const identityProvider = new CognitoIdentityProviderClient({ region: settings.region });

module.exports = function(RED) {

    /**
     * DuloNodeHub constructor function.
     * @param {object} config - The configuration for the node.
     */
    function DuloNodeHub(config) {
        
        RED.nodes.createNode(this, config);
        
        const node = this;
        
        let mqttClient;

        if (node.credentials && node.credentials.hasOwnProperty("email")) {
            node.email = node.credentials.email;
        }
        if (node.credentials && node.credentials.hasOwnProperty("password")) {
            node.password = node.credentials.password;
        }

        /**
         * Set the node status based on the type and optionally send a message.
         * @param {string} statusType - The type of status ('success', 'error', 'loading').
         * @param {string} text - The generic text to display in the node status.
         * @param {string} detailedMessage - A detailed message for the output payload.
         */
        function setStatus(statusType, text, detailedMessage) {
            let fill, shape;

            // Determine fill color and shape based on status type
            switch (statusType) {
                case 'success':
                    fill = 'green';
                    shape = 'dot';
                    break;
                case 'error':
                    fill = 'red';
                    shape = 'ring';
                    break;
                case 'loading':
                    fill = 'yellow';
                    shape = 'dot';
                    break;
                default:
                    fill = 'grey';
                    shape = 'ring';
                    break;
            }

            if (text !== '') {
                // Update the node's status
                node.status({ fill, shape, text });
            }

            if (detailedMessage !== '') {
                // Send a formatted message payload
                node.send({
                    payload: {
                        status: statusType,
                        message: detailedMessage
                    }
                });
            }
        }

        /**
         * Decode the provided token.
         * @param {string} token - The JWT token.
         * @returns {Object} - JWT decoded object.
         */
        function decodeToken(token) {
            return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        }

        /**
         * Checks if the provided token is valid by decoding it and checking expiration.
         * @param {string} token - The JWT token to validate.
         * @returns {boolean} - True if the token is valid, false otherwise.
         */
        function isTokenValid(token) {
            try {
                const decoded = decodeToken(token);
                const expiration = decoded.exp * 1000;
                return expiration > Date.now();
            } catch (e) {
                return false;
            }
        }

        /**
         * Retrieves a valid token from cache or triggers a fresh authentication.
         * Always returns a Promise.
         * @returns {Promise<string>} - A promise resolving to a valid token.
         */
        function getToken() {
            return new Promise((resolve, reject) => {
                let auth = node.context().get('apiAuth');

                if (auth?.token && isTokenValid(auth.token)) {
                    resolve(auth.token);
                } else {
                    authenticate()
                        .then(resolve)
                        .catch(reject);
                }
            });
        }

        /**
         * Initiates authentication with Cognito using provided email and password.
         * @returns {Promise<string>} - A promise resolving to the fresh authentication token.
         */
        function authenticate() {
            return new Promise((resolve, reject) => {
                const params = {
                    AuthFlow: 'USER_PASSWORD_AUTH',
                    ClientId: settings.clientId,
                    AuthParameters: {
                        USERNAME: node.email,
                        PASSWORD: node.password
                    }
                };

                identityProvider.send(new InitiateAuthCommand(params))
                    .then((data) => {
                        const token = data.AuthenticationResult.IdToken;
                        const decodedToken = decodeToken(token);
                        node.context().set('apiAuth', { token, user: decodedToken.sub });
                        resolve(token);
                    })
                    .catch((err) => {
                        setStatus('error', 'Authentication error', `Authentication error: ${err.message}`);
                        reject(err);
                    });
            });
        }

        /**
         * Check API and Client compatability
         * @param {string} minVersion - The minimum compatible version.
         */
        function compatibilityCheck(minVersion) {

            const currentVersion = settings.version.split('.').map(Number);
            const minimumVersion = minVersion.split('.').map(Number);

            for (let i = 0; i < Math.max(currentVersion.length, minimumVersion.length); i++) {
                const currentVersionNum = currentVersion[i] || 0;
                const minimumVersionNum = minimumVersion[i] || 0;
                if (currentVersionNum < minimumVersionNum) {
                    setStatus('error', 'Upgrade required', `Upgrade required to version ${minVersion}`);
                    return false;
                }
            }

            return true;
        }

        /**
         * Function to initiate MQTT connection.
         */
        function initMQTT() {
            const apiAuth = node.context().get('apiAuth');
            const mqttAuth = node.context().get('mqttAuth');

            if (!mqttAuth) {
                setStatus('error', 'Setup error', 'MQTT data not found in context storage');
                return;
            }

            const clientId = `${apiAuth.user}`;
            const topic = `hub/${apiAuth.user}/device/update`;

            const options = {
                clientId: clientId,
                keepalive: 120,
                cert: mqttAuth.certificate,
                key: mqttAuth.private,
                rejectUnauthorized: true
            };

            const url = `mqtts://${mqttAuth.endpoint}:8883`;

            // Disconnect the existing client
            if (mqttClient) {
                try {
                    mqttClient.end();
                } catch (error) {
                    setStatus('error', 'MQTT error', `Error stopping MQTT client: ${error.message}`);
                }
            }

            // Initialize a new MQTT client
            mqttClient = mqtt.connect(url, options);

            mqttClient.on('connect', () => {
                mqttClient.subscribe(topic, { qos: 1 }, (err) => {
                    if (err) {
                        setStatus('error', 'error', `Error subscribing to topic: ${err.message}`);
                    } else {
                        setStatus('success', 'connected', '');
                    }
                });
            });
            
            // Event listener for incoming messages
            mqttClient.on('message', (topic, message) => {
                const data = message.toString('utf8');

                if (data) {
                    try {
                        const payload = JSON.parse(data);
                        node.send({ payload });
                    } catch (jsonError) {
                        setStatus('error', '', `Error parsing JSON payload: ${jsonError.message}`);
                    }
                } else {
                    setStatus('error', '', 'Empty payload received from MQTT');
                }
            });

            // Event listener for errors
            mqttClient.on('error', (error) => {
                setStatus('error', 'MQTT error', `MQTT Client Error: ${error.message}`);
            });
        }

        function deploy() {
            const nodeWires = node.wires || [];
            const connectedNodes = {};

            RED.nodes.eachNode((currentNode) => {
                nodeWires.forEach(output => {
                    output.forEach(connectedNodeID => {
                        if (currentNode.id === connectedNodeID && currentNode.type === "DuloNodeDevice") {
                            connectedNodes[connectedNodeID] = {
                                name: currentNode.name || "Unnamed",
                                type: currentNode.deviceType || "light"
                            };
                        }
                    });
                });
            });

            getToken()
                .then((token) => {

                    setStatus('loading', 'deploying', '');
                    axios.post(`${settings.apiURL}/hub/deploy`, connectedNodes, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    })
                    .then((response) => {
                        const { data } = response.data;

                        if ( data?.minVersion && compatibilityCheck(data.minVersion) ){
                            if (data?.auth) {
                                const { certificate, private, endpoint } = data.auth;
                                node.context().set('mqttAuth', { certificate, private, endpoint });
                                initMQTT();
                            }
    
                            if (data?.devices) {
                                // Notify devices
                                node.send({
                                    payload: {
                                        status: 'deployed',
                                        devices: data.devices
                                    }
                                });
                            }
                        }
                    })
                    .catch((err) => {
                        setStatus('error', 'Deployment error', `Deployment error: ${err.message}`);
                    });

                })
                .catch((err) => {
                    setStatus('error', 'Token error', `Token retrieval error: ${err.message}`);
                });
        }

        // Handle node input
        node.on('input', function (msg) {
            getToken()
                .then((token) => {
                    axios.post(`${settings.apiURL}/device/set`, msg.payload, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    })
                    .catch((err) => {
                        setStatus('error', 'Request failed', `Request to set device state failed: ${err.message}`);
                    });
                })
                .catch((err) => {
                    setStatus('error', 'Error', `Failed to retrieve token: ${err.message}`);
                });
        });

        // Handle node shutdown or redeployment
        node.on('close', function (done) {
            if (mqttClient) {
                try {
                    mqttClient.end();
                    done();
                } catch (error) {
                    setStatus('error', 'MQTT stopping error', `Error stopping MQTT client: ${error.message}`);
                    done(error);
                }
            } else {
                done();
            }
        });

        /**
        * Backend methods to handle requests from the frontend
        */
        RED.httpNode.get('/dulonode/subscription/upgrade', async (req, res) => {

            getToken()
            .then((token) => {
                axios.get(`${settings.apiURL}/subscription/upgrade`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                })
                .then((response) => {
                    const { data } = response.data;

                    if (data?.url) {
                        res.redirect(data.url);
                    } else {
                        res.status(500).send({ error: 'No URL returned' });
                    }
                })
                .catch((err) => {
                    setStatus('error', 'Upgrade subscription error', `Upgrade subscription error: ${err.message}`);
                    res.status(500).send({ error: error.message });
                });
            })
            .catch((err) => {
                setStatus('error', 'Token error', `Token retrieval error: ${err.message}`);
            });

        });

        RED.httpNode.get('/dulonode/subscription/manage', async (req, res) => {
            try {
                const token = await getToken();
                const response = await axios.get(`${settings.apiURL}/subscription/manage`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
        
                const { data } = response.data;
        
                if (data?.url) {
                    // Redirect the client to the URL
                    res.redirect(data.url);
                } else {
                    // Handle case where no URL is returned
                    res.status(500).send({ error: 'No URL returned' });
                }
            } catch (err) {
                // Log and handle errors
                setStatus('error', 'Manage subscription error', `Manage subscription error: ${err.message}`);
                res.status(500).send({ error: err.message });
            }
        });        

        RED.httpNode.get('/dulonode/subscription/details', async (req, res) => {

            if (!node.email || !node.password) {
                res.json({});
            } else {
                try {
                    const token = await getToken();
                    const response = await axios.get(`${settings.apiURL}/subscription/details`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });
            
                    const { data } = response.data;
            
                    if (data) {
                        res.json(data);
                    } else {
                        res.status(500).send({ error: 'No subscription details returned' });
                    }
                } catch (err) {
                    // Log and handle errors
                    setStatus('error', 'Subscription details error', `Subscription details error: ${err.message}`);
                    res.status(500).send({ error: err.message });
                }
            }
        });

        RED.httpNode.get('/dulonode/installation', async (req, res) => {
            res.json({ installation: process.env.HASSIO_TOKEN ? 'homeassistant' : 'standalone' });
        });

        /**
         * On deploy, collect connected devices and send them to the API
         */
        if (!node.email || !node.password) {
            setStatus('error', 'Account configuration', 'The account email or password is not configured.');
            return;
        } else {
            deploy();
        }
    }

    RED.nodes.registerType('DuloNodeHub', DuloNodeHub, {
        credentials: {
            email: { type: 'text' },
            password: { type: 'password' }
        }
    });
};