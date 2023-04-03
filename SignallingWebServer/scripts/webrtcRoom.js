


let WebSocket = require('ws');
const { URL } = require('url');


const logging = require('../modules/logging.js');

let roomId = ''
let streamer = null;        // WebSocket connected to Streamer
let sfu = null;				// WebSocket connected to SFU
let players = new Map(); 	// playerId <-> player, where player is either a web-browser or a native webrtc player


let streamerSourceName = "Streamer";

const SFUPlayerId = "1"; // sfu is a special kind of player
let nextPlayerId = 100; // reserve some player ids
let playerCount = 0; // current player count


function sfuIsConnected() {
	return sfu && sfu.readyState == 1;
}

function streamerIsConnected() {
    return streamer && sfu.readyState == 1;
}

function logIncoming(sourceName, msgType, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Blue, "\x1b[37m-> %s\x1b[34m: %s", sourceName, msg);
	else
		console.logColor(logging.Blue, "\x1b[37m-> %s\x1b[34m: %s", sourceName, msgType);
}

function logOutgoing(destName, msgType, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Green, "\x1b[37m<- %s\x1b[32m: %s", destName, msg);
	else
		console.logColor(logging.Green, "\x1b[37m<- %s\x1b[32m: %s", destName, msgType);
}



// normal peer to peer signalling goes to streamer. SFU streaming signalling goes to the sfu
function sendMessageToController(msg, skipSFU, skipStreamer = false) {
	const rawMsg = JSON.stringify(msg);
	if (sfu && sfu.readyState == 1 && !skipSFU) {
		logOutgoing("SFU-"+roomId, msg.type, rawMsg);
		sfu.send(rawMsg);
	} 
	if (streamer && streamer.readyState == 1 && !skipStreamer) {
		logOutgoing("Streamer-"+roomId, msg.type, rawMsg);
		streamer.send(rawMsg);
	} 
	
	if (!sfu && !streamer) {
		console.error("room-%s sendMessageToController: No streamer or SFU connected!\nMSG: %s", roomId, rawMsg);
	}
}

function sendMessageToPlayer(playerId, msg) {
	let player = players.get(playerId);
	if (!player) {
		console.log(`dropped message ${msg.type} as the player ${playerId} is not found`);
		return;
	}
	const playerName = playerId == SFUPlayerId ? "SFU" : `player ${playerId}`;
	const rawMsg = JSON.stringify(msg);
	logOutgoing(`${playerName}-${roomId}`, msg.type, rawMsg);
	player.ws.send(rawMsg);
}



function disconnectAllPlayers(code, reason) {
	console.log(streamerSourceName + "  killing all players");
	let clone = new Map(players);
	for (let player of clone.values()) {
		if (player.id != SFUPlayerId) { // dont dc the sfu
			player.ws.close(code, reason);
		}
	}
}


function disconnectSFUPlayer() {
	console.log(`disconnecting SFU-${roomId} from streamer`);
	if(players.has(SFUPlayerId)) {
		players.get(SFUPlayerId).ws.close(4000, "SFU Disconnected");
		players.delete(SFUPlayerId);
	}
	sendMessageToController({ type: 'playerDisconnected', playerId: SFUPlayerId }, true, false);
}


function addStreamer(ws) {
    
    // sendStreamerConnectedToMatchmaker();

    ws.on('message', (msgRaw) => {

		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch(err) {
			console.error(`cannot parse ${streamerSourceName} message: ${msgRaw}\nError: ${err}`);
			streamer.close(1008, 'Cannot parse');
			return;
		}

		logIncoming(streamerSourceName, msg.type, msgRaw);
	
		try {
			// just send pings back to sender
			if (msg.type == 'ping') {
				const rawMsg = JSON.stringify({ type: "pong", time: msg.time});
				logOutgoing(streamerSourceName, msg.type, rawMsg);
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
				sendMessageToPlayer(playerId, msg);
			} else if (msg.type == 'answer') {
				sendMessageToPlayer(playerId, msg);
			} else if (msg.type == 'iceCandidate') {
				sendMessageToPlayer(playerId, msg);
			} else if (msg.type == 'disconnectPlayer') {
				let player = players.get(playerId);
				if (player) {
					player.ws.close(1011 /* internal error */, msg.reason);
				}
			} else {
				console.error(`unsupported ${streamerSourceName} message type: ${msg.type}`);
			}
		} catch(err) {
			console.error(`ERROR: ${streamerSourceName} ws.on message error: ${err.message}`);
		}
	});

    function onStreamerDisconnected() {
		// sendStreamerDisconnectedToMatchmaker();
		disconnectAllPlayers();
		if (sfuIsConnected()) {
			const msg = { type: "streamerDisconnected" };
			sfu.send(JSON.stringify(msg));
		}
		streamer = null;
	}

    ws.on('close', function(code, reason) {
		console.error(`${streamerSourceName} disconnected: ${code} - ${reason}`);
		onStreamerDisconnected();
	});

    ws.on('error', function(error) {
		console.error(`${streamerSourceName} connection error: ${error}`);
		onStreamerDisconnected();
		try {
			ws.close(1006 /* abnormal closure */, error);
		} catch(err) {
			console.error(`ERROR: ${streamerSourceName} ws.on error: ${err.message}`);
		}
	});

    streamer = ws;

    if (sfuIsConnected()) {
		const msg = { type: "playerConnected", playerId: SFUPlayerId, dataChannel: true, sfu: true };
		streamer.send(JSON.stringify(msg));
	}
}


function addSfu(ws) {
    
	players.set(SFUPlayerId, { ws: ws, id: SFUPlayerId });

    ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch (err) {
			console.error(`cannot parse SFU-${roomId} message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		logIncoming("SFU-"+roomId, msg.type, msgRaw);

		if (msg.type == 'offer') {
			// offers from the sfu are for players
			const playerId = msg.playerId;
			delete msg.playerId;
			sendMessageToPlayer(playerId, msg);
		}
		else if (msg.type == 'answer') {
			// answers from the sfu are for the streamer
			msg.playerId = SFUPlayerId;
			const rawMsg = JSON.stringify(msg);
			logOutgoing(streamerSourceName, msg.type, rawMsg);
			streamer.send(rawMsg);
		}
		else if (msg.type == 'streamerDataChannels') {
			// sfu is asking streamer to open a data channel for a connected peer
			msg.sfuId = SFUPlayerId;
			const rawMsg = JSON.stringify(msg);
			logOutgoing(streamerSourceName, msg.type, rawMsg);
			streamer.send(rawMsg);
		}
		else if (msg.type == 'peerDataChannels') {
			// sfu is telling a peer what stream id to use for a data channel
			const playerId = msg.playerId;
			delete msg.playerId;
			sendMessageToPlayer(playerId, msg);
			// remember the player has a data channel
			const player = players.get(playerId);
			player.datachannel = true;
		}
	});

	ws.on('close', function(code, reason) {
		console.error(`SFU-${roomId} disconnected: ${code} - ${reason}`);
		sfu = null;
		disconnectSFUPlayer();
	});

	ws.on('error', function(error) {
		console.error(`SFU-${roomId} connection error: ${error}`);
		sfu = null;
		disconnectSFUPlayer();
		try {
			ws.close(1006 /* abnormal closure */, error);
		} catch(err) {
			console.error(`ERROR: ${roomId} ws.on error: ${err.message}`);
		}
	});

	sfu = ws;

	if (streamer && streamer.readyState == 1) {
		const msg = { type: "playerConnected", playerId: SFUPlayerId, dataChannel: true, sfu: true };
		streamer.send(JSON.stringify(msg));
	}
}

function addPlayer(ws, req, preferSFU) {
    const skipSFU = !preferSFU;
	const skipStreamer = preferSFU && sfu;

    if(preferSFU && !sfu) {
		ws.send(JSON.stringify({ type: "warning", warning: "Even though ?preferSFU was specified, there is currently no SFU connected." }));
	}

    
	++playerCount;
    let playerId = (++nextPlayerId).toString();
	console.logColor(logging.Green, `room-${roomId} player ${playerId} (${req.connection.remoteAddress}) connected`);

    players.set(playerId, { ws: ws, id: playerId });

    function sendPlayersCount() {
		let playerCountMsg = JSON.stringify({ type: 'playerCount', count: players.size });
		for (let p of players.values()) {
			p.ws.send(playerCountMsg);
		}
	}

    ws.on('message', (msgRaw) =>{

		var msg;
		try {
			msg = JSON.parse(msgRaw);
		} catch (err) {
			console.error(`room-${roomId} cannot parse player ${playerId} message: ${msgRaw}\nError: ${err}`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		if(!msg || !msg.type)
		{
			console.error(`room-${roomId} player: ${playerId} Cannot parse message ${msgRaw}`);
			return;
		}
		
		logIncoming(`room-${roomId} player ${playerId}`, msg.type, msgRaw);

		if (msg.type == 'offer') {
			msg.playerId = playerId;
			sendMessageToController(msg, skipSFU);
		} else if (msg.type == 'answer') {
			msg.playerId = playerId;
			sendMessageToController(msg, skipSFU, skipStreamer);
		} else if (msg.type == 'iceCandidate') {
			msg.playerId = playerId;
			sendMessageToController(msg, skipSFU, skipStreamer);
		} else if (msg.type == 'stats') {
			console.log(`room-${roomId}  player ${playerId}: stats\n${msg.data}`);
		} else if (msg.type == "dataChannelRequest") {
			msg.playerId = playerId;
			sendMessageToController(msg, skipSFU, true);
		} else if (msg.type == "peerDataChannelsReady") {
			msg.playerId = playerId;
			sendMessageToController(msg, skipSFU, true);
		}
		else {
			console.error(`room-${roomId} player ${playerId}: unsupported message type: ${msg.type}`);
			return;
		}
	});

    function onPlayerDisconnected() {
		try {
			--playerCount;
			const player = players.get(playerId);
			if (player.datachannel) {
				// have to notify the streamer that the datachannel can be closed
				sendMessageToController({ type: 'playerDisconnected', playerId: playerId }, true, false);
			}
			players.delete(playerId);
			sendMessageToController({ type: 'playerDisconnected', playerId: playerId }, skipSFU);
			// sendPlayerDisconnectedToFrontend();
			// sendPlayerDisconnectedToMatchmaker();
			sendPlayersCount();
		} catch(err) {
			console.logColor(logging.Red, `ERROR:: room-${roomId} onPlayerDisconnected error: ${err.message}`);
		}
	}

	ws.on('close', function(code, reason) {
		console.logColor(logging.Yellow, `room-${roomId} player ${playerId} connection closed: ${code} - ${reason}`);
		onPlayerDisconnected();
	});

	ws.on('error', function(error) {
		console.error(`room-${roomId} player ${playerId} connection error: ${error}`);
		ws.close(1006 /* abnormal closure */, error);
		onPlayerDisconnected();

		console.logColor(logging.Red, `room-${roomId} player ${playerId} Trying to reconnect...`);
		reconnect();
	});

    // sendPlayerConnectedToFrontend();
	// sendPlayerConnectedToMatchmaker();

	// ws.send(JSON.stringify(clientConfig));

	sendMessageToController({ type: "playerConnected", playerId: playerId, dataChannel: true, sfu: false }, skipSFU, skipStreamer);
	sendPlayersCount();
}



module.exports = class webrtcRoom {
    constructor(room_id) {
        roomId = room_id;
        streamerSourceName = 'Streamer-' + room_id;
    }

    sfuIsConnected = sfuIsConnected;
    streamerIsConnected = streamerIsConnected;
    streamerIsNull = function() {
        return streamer === null
    }

    addStreamer = addStreamer;
    addSfu = addSfu;
    addPlayer = addPlayer;

    playerCount = function() {
        return playerCount;
    }
}


