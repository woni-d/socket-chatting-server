const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const redis = require('socket.io-redis');
const dataManager = require('./dataManager');
const dbManager = require('./dbManager');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const server = http.createServer(app);
server.listen(process.env.PORT || 3000, () => {
    console.log('Server is running!');
})

mongoose.connect('mongodb://localhost:27017', { useUnifiedTopology: true, useNewUrlParser: true, dbName: 'socket_chatting' });
mongoose.connection.once('open', () => {
    console.log('DB is connected!');
})

const io = socketIo(server, {
    pingTimeout: 60000,
    pingInterval: 60000
});

io.adapter(redis({ host: '127.0.0.1', port: 6379 }));

dataManager.setIo(io);

let userIndex = 1;

io.on('connection', (socket) => {
    socket.on('disconnect', () => {
        const socketId = socket.id;
        
        const roomMap = dataManager.getRoomMap();
        const roomMapKeys = Object.keys(roomMap);

        for (let i = 0; i < roomMapKeys.length; i++) {
            if (roomMap[roomMapKeys[i]].users.filter(user => user === socketId).length > 0) {
                const roomId = roomMapKeys[i];

                socket.leave(roomId);

                const users = dataManager.getRoom(roomId).users;
                if (users.length <= 0) {
                    dataManager.unsetRoom(roomId);
                    return socket.broadcast.emit('admin_delete_data', { room: roomId });
                }
                
                let additionalMessage = '';
                if (users.indexOf(socketId) === 0) {
                    additionalMessage += `기존 방 주인이었던 '${dataManager.getUser(socketId).name}'이(가) 나갔으므로 '${dataManager.getUser(users[0]).name}'이(가) 방 주인이 됩니다.`;
                }

                dataManager.deleteUserFromRoom(roomId, socketId);

                socket.broadcast.emit('admin_data', {
                    roomUsers: { room: roomId, users: dataManager.getRoom(roomId).users }
                });
                socket.to(roomId).emit('admin_message', {
                    message: `'${dataManager.getUser(socketId).name}'가 방에서 나갔습니다. ${additionalMessage}`
                });

                break
            }
        }

        socket.broadcast.emit('notice', {
            message: `${dataManager.getUser(socketId).name}이(가) 접속을 종료했습니다!`
        });
        socket.broadcast.emit('admin_delete_data', { user: socketId });

        dataManager.unsetUser(socketId);
    });

    socket.on('register', () => {
        const socketId = socket.id;
        const userName = `유저${userIndex++}`;

        dataManager.setSocket(socket);
        dataManager.setUser(socketId, { name: userName, createdAt: new Date() });

        socket.broadcast.emit('notice', { message: `'${userName}'이(가) 서버에 접속했습니다!` });
        socket.broadcast.emit('admin_data', { userMap: { [socketId]: dataManager.getUser(socketId) } });
        socket.emit('admin_data', {
            id: socket.id,
            name: userName,
            userMap: dataManager.getUserMap(),
            roomMap: dataManager.getRoomMap()
        });
        socket.emit('admin_message', { message: `사용자 이름 '${userName}'을(를) 부여받았습니다` });
    });

    socket.on('change_name', (data) => {
        const socketId = socket.id;
        const { text: nickname } = data;

        if (dataManager.getUserNames().includes(nickname)) {
            socket.emit('admin_error', { message: `'${nickname}'은(는) 중복된 닉네임입니다` });
        } else {
            const oldNickname = dataManager.getUser(socketId).name;

            dataManager.setUser(socketId, { name: nickname });

            socket.broadcast.emit('admin_data', {
                userMap: { [socketId]: dataManager.getUser(socketId) } 
            });
            socket.broadcast.emit('admin_message', {
                message: `유저 '${oldNickname}'이(가) '${nickname}'로 이름을 변경했습니다!`
            });
            socket.emit('admin_data', { name: nickname });
            // io.to(socket.id).emit('admin_data', { name: nickname }); // Send to specific socket id
        }
    });

    socket.on('loud_speaker', (data) => {
        const socketId = socket.id;
        const { text: message } = data;

        dataManager.getUserKeys().forEach(tempSocketId => {
            if (!dataManager.getDisableLoudSpeakerKeys().includes(tempSocketId)) {
                io.to(tempSocketId).emit('loud_speaker', {
                    user: dataManager.getUser(socketId).name,
                    message
                });
            }
        });
    });

    socket.on('update_loud_speaker_settings', () => {
        const socketId = socket.id;
        let loudSpeakerOn = undefined;
        
        if (dataManager.getDisableLoudSpeakerKeys().includes(socketId)) {
            dataManager.unsetDisableLoudSpeaker(socketId);
            loudSpeakerOn = true;
        } else {
            dataManager.setDisableLoudSpeaker(socketId);
            loudSpeakerOn = false;
        }

        socket.emit('admin_data', { loudSpeakerOn });
        socket.emit('admin_message', { message: '확성기 설정을 변경했습니다' });
    });

    socket.on('create_room', (data) => {
        const socketId = socket.id;
        const { text: roomId, arguments: invitedUsers, password } = data;

        if (roomId && invitedUsers && Array.isArray(invitedUsers) && invitedUsers.length > 0) {
            const userIds = [socketId];
            const userNames = [];

            socket.join(roomId);

            invitedUsers.forEach(tempSocketId => {
                const user = dataManager.getUser(tempSocketId);
                if (user) {
                    dataManager.getSocket(tempSocketId).join(roomId);
                    userIds.push(tempSocketId);
                    userNames.push(user.name);
                }
            });

            if (userNames.length <= 0) {
                return socket.emit('admin_error', { message: '방 만들기에 실패했습니다!' })
            }

            dataManager.setRoom(roomId, { password, users: userIds, createdAt: new Date() });

            io.emit('admin_data', { roomMap: { [roomId]: dataManager.getRoom(roomId) } });
            io.in(roomId).emit('admin_data', { room: roomId });
            io.in(roomId).emit('admin_message', {
                message: `'${dataManager.getUser(socketId).name}'이(가) '${userNames.join(', ')}'을(를) '${roomId}'에 초대했습니다!`
            });
        } else {
            socket.emit('admin_error', { message: `방을 만들 수 없습니다!` });
        }
    });

    socket.on('send_message', (data) => {
        const socketId = socket.id;
        const { text: message, room: roomId } = data;

        if (message && roomId) {
            io.in(roomId).emit('send_message', { user: dataManager.getUser(socketId).name, message });
        } else {
            socket.emit('admin_error', { message: `빈 메시지가 전달되었습니다!` });
        }
    });

    socket.on('join_room', (data) => {
        const socketId = socket.id;
        const { room: roomId } = data;

        socket.join(roomId);
        dataManager.addUserToRoom(roomId, socketId);

        io.emit('admin_data', {
            roomUsers: { room: roomId, users: dataManager.getRoom(roomId).users }
        });
        io.in(roomId).emit('admin_data', { room: roomId });
        io.in(roomId).emit('admin_message', { message: `'${dataManager.getUser(socketId).name}'이(가) 방에 들어왔습니다!` });
    }); // TODO: 방에 입장하기 -> 잠겨있을 때에는 비밀번호 보내야 함

    socket.on('leave_room', (data) => {
        const socketId = socket.id;
        const { room: roomId } = data;
        
        if (roomId) {
            socket.leave(roomId);

            const users = dataManager.getRoom(roomId).users;
            if (users.length <= 0) {
                dataManager.unsetRoom(roomId);
                io.emit('admin_delete_data', { room: roomId });
                return socket.emit('admin_message', { message: '방에 남은 사람이 없어 방이 삭제되었습니다!' });
            }
            
            let additionalMessage = '';
            if (users.indexOf(socketId) === 0) {
                additionalMessage += `기존 방 주인이었던 '${dataManager.getUser(socketId).name}'이(가) 나갔으므로 '${dataManager.getUser(users[0]).name}'이(가) 방 주인이 됩니다.`;
            }

            dataManager.deleteUserFromRoom(roomId, socketId);

            io.emit('admin_data', {
                roomUsers: { room: roomId, users: dataManager.getRoom(roomId).users }
            });
            socket.to(roomId).emit('admin_message', {
                message: `'${dataManager.getUser(socketId).name}'가 방에서 나갔습니다. ${additionalMessage}`
            });
            socket.emit('admin_message', { message: '방에서 나왔습니다.'});
        } else {
            socket.emit('admin_error', { message: `정상적으로 방에서 나갈 수 없습니다!` });
        }
    });

    // socket.on('lock_room') // TODO: 방 비밀번호 설정
    // socket.on('update_room_password') // TODO: 방 비밀번호 변경

    // socket.on('') // TODO: 방에서 강퇴시키기(마스터 권한 필요)
    // socker.on('') // TODO: 방 폭파(마스터 권한 필요)

    // socket.on('') // TOOD: 권한 넘기기(마스터 권한 필요)

    // socket.on('set_room_notice') // 방 공지 설정(마스터 권한 필요)
    // socket.on('set_room_color') // 방 대표색 설정(마스터 권한 필요)

    // socket.on('invite_friend') // TODO: 내가 있는 방에 친구 초대하기(비밀번호가 있어도 없는 것처럼 동작해야 함)
});