


let WebSocket = require('ws');
const { URL } = require('url');


const logging = require('../modules/logging.js');

const SFUPlayerId = "1"; // sfu is a special kind of player

let logVerbose = false;

function logIncoming(sourceName, msgType, msg) {
	if (logVerbose)
		console.logColor(logging.Blue, "\x1b[37m-> %s\x1b[34m: %s", sourceName, msg);
	else
		console.logColor(logging.Blue, "\x1b[37m-> %s\x1b[34m: %s", sourceName, msgType);
}

function logOutgoing(destName, msgType, msg) {
	if (logVerbose)
		console.logColor(logging.Green, "\x1b[37m<- %s\x1b[32m: %s", destName, msg);
	else
		console.logColor(logging.Green, "\x1b[37m<- %s\x1b[32m: %s", destName, msgType);
}



class webrtcRoom {

    roomId = '';            // Room Id
    streamer = null;        // WebSocket connected to Streamer
    sfu = null;				// WebSocket connected to SFU
    players = new Map(); 	// playerId <-> player, where player is either a web-browser or a native webrtc player


    streamerSourceName = "Streamer";

    nextPlayerId = 100; // reserve some player ids
    playerCount = 0; // current player count

    constructor(room_id, log_verbose) {
        this.roomId = room_id;
        this.streamerSourceName = 'Streamer-' + room_id;
        logVerbose = log_verbose;
    }


    sfuIsConnected = function () {
        return this.sfu && this.sfu.readyState == 1;
    }

    streamerIsConnected = function () {
        return this.streamer && this.streamer.readyState == 1;
    }

    streamerIsNull = function() {
        return this.streamer === null
    }


    // normal peer to peer signalling goes to streamer. SFU streaming signalling goes to the sfu
    sendMessageToController = function (msg, skipSFU, skipStreamer = false) {
        const rawMsg = JSON.stringify(msg);
        if (this.sfu && this.sfu.readyState == 1 && !skipSFU) {
            logOutgoing("SFU-"+this.roomId, msg.type, rawMsg);
            this.sfu.send(rawMsg);
        } 
        if (this.streamer && this.streamer.readyState == 1 && !skipStreamer) {
            logOutgoing("Streamer-"+this.roomId, msg.type, rawMsg);
            this.streamer.send(rawMsg);
        } 
        
        if (!this.sfu && !this.streamer) {
            console.error("room-%s sendMessageToController: No streamer or SFU connected!\nMSG: %s", roomId, rawMsg);
        }
    }

    sendMessageToPlayer = function (playerId, msg) {
        let player = this.players.get(playerId);
        if (!player) {
            console.log(`dropped message ${msg.type} as the player ${playerId} is not found`);
            return;
        }
        const playerName = playerId == SFUPlayerId ? "SFU" : `player ${playerId}`;
        const rawMsg = JSON.stringify(msg);
        logOutgoing(`${playerName}-${this.roomId}`, msg.type, rawMsg);
        player.ws.send(rawMsg);
    }


    disconnectAllPlayers = function (code, reason) {
        console.log(this.streamerSourceName + "  killing all players");
        let clone = new Map(this.players);
        for (let player of clone.values()) {
            if (player.id != SFUPlayerId) { // dont dc the sfu
                player.ws.close(code, reason);
            }
        }
    }


    disconnectSFUPlayer = function () {
        console.log(`disconnecting SFU-${this.roomId} from streamer`);
        if(this.players.has(SFUPlayerId)) {
            this.players.get(SFUPlayerId).ws.close(4000, "SFU Disconnected");
            this.players.delete(SFUPlayerId);
        }
        this.sendMessageToController({ type: 'playerDisconnected', playerId: SFUPlayerId }, true, false);
    }

    
    addStreamer = function (ws) {
        
        // sendStreamerConnectedToMatchmaker();

        ws.on('message', (msgRaw) => {

            var msg;
            try {
                msg = JSON.parse(msgRaw);
            } catch(err) {
                console.error(`cannot parse ${this.streamerSourceName} message: ${msgRaw}\nError: ${err}`);
                this.streamer.close(1008, 'Cannot parse');
                return;
            }

            logIncoming(this.streamerSourceName, msg.type, msgRaw);
        
            try {
                // just send pings back to sender
                if (msg.type == 'ping') {
                    const rawMsg = JSON.stringify({ type: "pong", time: msg.time});
                    logOutgoing(this.streamerSourceName, msg.type, rawMsg);
                    ws.send(rawMsg);
                    return;
                }

                // Convert incoming playerId to a string if it is an integer, if needed. (We support receiving it as an int or string).
                let playerId = msg.playerId;
                if (playerId && typeof playerId === 'number')
                {
                    playerId = playerId.toString();
                }
                delete msg.playerId; // no need to send it to the player
                
                if (msg.type == 'offer') {
                    this.sendMessageToPlayer(playerId, msg);
                } else if (msg.type == 'answer') {
                    this.sendMessageToPlayer(playerId, msg);
                } else if (msg.type == 'iceCandidate') {
                    this.sendMessageToPlayer(playerId, msg);
                } else if (msg.type == 'disconnectPlayer') {
                    let player = this.players.get(playerId);
                    if (player) {
                        player.ws.close(1011 /* internal error */, msg.reason);
                    }
                } else {
                    console.error(`unsupported ${this.streamerSourceName} message type: ${msg.type}`);
                }
            } catch(err) {
                console.error(`ERROR: ${this.streamerSourceName} ws.on message error: ${err.message}`);
            }
        });

        let room = this
        function onStreamerDisconnected() {
            // sendStreamerDisconnectedToMatchmaker();
            room.disconnectAllPlayers();
            if (room.sfuIsConnected()) {
                const msg = { type: "streamerDisconnected" };
                room.sfu.send(JSON.stringify(msg));
            }
            room.streamer = null;
        }

        ws.on('close', function(code, reason) {
            console.error(`${room.streamerSourceName} disconnected: ${code} - ${reason}`);
            onStreamerDisconnected();
        });

        ws.on('error', function(error) {
            console.error(`${room.streamerSourceName} connection error: ${error}`);
            onStreamerDisconnected();
            try {
                ws.close(1006 /* abnormal closure */, error);
            } catch(err) {
                console.error(`ERROR: ${room.streamerSourceName} ws.on error: ${err.message}`);
            }
        });

        this.streamer = ws;

        if (this.sfuIsConnected()) {
            const msg = { type: "playerConnected", playerId: SFUPlayerId, dataChannel: true, sfu: true };
            this.streamer.send(JSON.stringify(msg));
        }
    }


    addSfu = function (ws) {
    
        this.players.set(SFUPlayerId, { ws: ws, id: SFUPlayerId });
    
        ws.on('message', (msgRaw) => {
            var msg;
            try {
                msg = JSON.parse(msgRaw);
            } catch (err) {
                console.error(`cannot parse SFU-${this.roomId} message: ${msgRaw}\nError: ${err}`);
                ws.close(1008, 'Cannot parse');
                return;
            }
    
            logIncoming("SFU-"+this.roomId, msg.type, msgRaw);
    
            if (msg.type == 'offer') {
                // offers from the sfu are for players
                const playerId = msg.playerId;
                delete msg.playerId;
                this.sendMessageToPlayer(playerId, msg);
            }
            else if (msg.type == 'answer') {
                // answers from the sfu are for the streamer
                msg.playerId = SFUPlayerId;
                const rawMsg = JSON.stringify(msg);
                logOutgoing(this.streamerSourceName, msg.type, rawMsg);
                this.streamer.send(rawMsg);
            }
            else if (msg.type == 'streamerDataChannels') {
                // sfu is asking streamer to open a data channel for a connected peer
                msg.sfuId = SFUPlayerId;
                const rawMsg = JSON.stringify(msg);
                logOutgoing(this.streamerSourceName, msg.type, rawMsg);
                this.streamer.send(rawMsg);
            }
            else if (msg.type == 'peerDataChannels') {
                // sfu is telling a peer what stream id to use for a data channel
                const playerId = msg.playerId;
                delete msg.playerId;
                this.sendMessageToPlayer(playerId, msg);
                // remember the player has a data channel
                const player = this.players.get(playerId);
                player.datachannel = true;
            }
        });
    
        ws.on('close', function(code, reason) {
            console.error(`SFU-${this.roomId} disconnected: ${code} - ${reason}`);
            this.sfu = null;
            this.disconnectSFUPlayer();
        });
    
        ws.on('error', function(error) {
            console.error(`SFU-${this.roomId} connection error: ${error}`);
            this.sfu = null;
            this.disconnectSFUPlayer();
            try {
                ws.close(1006 /* abnormal closure */, error);
            } catch(err) {
                console.error(`ERROR: ${this.roomId} ws.on error: ${err.message}`);
            }
        });
    
        this.sfu = ws;
    
        if (this.streamer && this.streamer.readyState == 1) {
            const msg = { type: "playerConnected", playerId: SFUPlayerId, dataChannel: true, sfu: true };
            this.streamer.send(JSON.stringify(msg));
        }
    }


    addPlayer = function (ws, req, preferSFU) {
        const skipSFU = !preferSFU;
        const skipStreamer = preferSFU && this.sfu;
    
        if(preferSFU && !this.sfu) {
            ws.send(JSON.stringify({ type: "warning", warning: "Even though ?preferSFU was specified, there is currently no SFU connected." }));
        }
        
    
        ++this.playerCount;
        let playerId = (++this.nextPlayerId).toString();
        console.logColor(logging.Green, `room-${this.roomId} player ${playerId} (${req.connection.remoteAddress}) connected`);
    
        this.players.set(playerId, { ws: ws, id: playerId });
        
        let room = this
    
        function sendPlayersCount() {
            // let playerCountMsg = JSON.stringify({ type: 'playerCount', count: room.players.size });
            // for (let p of room.players.values()) {
            //     p.ws.send(playerCountMsg);
            // }
        }
    
        ws.on('message', (msgRaw) =>{
    
            var msg;
            try {
                msg = JSON.parse(msgRaw);
            } catch (err) {
                console.error(`room-${room.roomId} cannot parse player ${playerId} message: ${msgRaw}\nError: ${err}`);
                ws.close(1008, 'Cannot parse');
                return;
            }
    
            if(!msg || !msg.type)
            {
                console.error(`room-${room.roomId} player: ${playerId} Cannot parse message ${msgRaw}`);
                return;
            }
            
            logIncoming(`room-${room.roomId} player ${playerId}`, msg.type, msgRaw);
    
            if (msg.type == 'offer') {
                msg.playerId = playerId;
                room.sendMessageToController(msg, skipSFU);
            } else if (msg.type == 'answer') {
                msg.playerId = playerId;
                room.sendMessageToController(msg, skipSFU, skipStreamer);
            } else if (msg.type == 'iceCandidate') {
                msg.playerId = playerId;
                room.sendMessageToController(msg, skipSFU, skipStreamer);
            } else if (msg.type == 'stats') {
                console.log(`room-${this.roomId}  player ${playerId}: stats\n${msg.data}`);
            } else if (msg.type == "dataChannelRequest") {
                msg.playerId = playerId;
                room.sendMessageToController(msg, skipSFU, true);
            } else if (msg.type == "peerDataChannelsReady") {
                msg.playerId = playerId;
                room.sendMessageToController(msg, skipSFU, true);
            }
            else {
                console.error(`room-${room.roomId} player ${playerId}: unsupported message type: ${msg.type}`);
                return;
            }
        });
    
        function onPlayerDisconnected() {
            try {
                --room.playerCount;
                const player = room.players.get(playerId);
                if (player.datachannel) {
                    // have to notify the streamer that the datachannel can be closed
                    room.sendMessageToController({ type: 'playerDisconnected', playerId: playerId }, true, false);
                }
                room.players.delete(playerId);
                room.sendMessageToController({ type: 'playerDisconnected', playerId: playerId }, skipSFU);
                // sendPlayerDisconnectedToFrontend();
                // sendPlayerDisconnectedToMatchmaker();
                sendPlayersCount();
            } catch(err) {
                console.logColor(logging.Red, `ERROR:: room-${room.roomId} onPlayerDisconnected error: ${err.message}`);
            }
        }
    
        ws.on('close', function(code, reason) {
            console.logColor(logging.Yellow, `room-${room.roomId} player ${playerId} connection closed: ${code} - ${reason}`);
            onPlayerDisconnected();
        });
    
        ws.on('error', function(error) {
            console.error(`room-${room.roomId} player ${playerId} connection error: ${error}`);
            ws.close(1006 /* abnormal closure */, error);
            onPlayerDisconnected();
    
            console.logColor(logging.Red, `room-${room.roomId} player ${playerId} Trying to reconnect...`);
            reconnect();
        });
    
        // sendPlayerConnectedToFrontend();
        // sendPlayerConnectedToMatchmaker();
    
        // ws.send(JSON.stringify(clientConfig));
    
        this.sendMessageToController({ type: "playerConnected", playerId: playerId, dataChannel: true, sfu: false }, skipSFU, skipStreamer);
        sendPlayersCount();
    }
    
    getName = function() {
        return this.roomId
    }
}

module.exports = webrtcRoom
