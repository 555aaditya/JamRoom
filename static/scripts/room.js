document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    // Use the global JavaScript variables defined in room.html
    const roomKey = ROOM_KEY;
    const username = CURRENT_USER;
    
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages-container');
    const listenerCountElement = document.getElementById('listener-count');
    const leaveRoomButton = document.getElementById('leave-room-button'); // Reference the new button

    // On successful connection, emit a 'join' event
    socket.on('connect', () => {
        socket.emit('join', { username: username, room_key: roomKey });
    });

    // Listen for new chat messages and display them
    socket.on('new_message', (data) => {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<strong>${data.username}:</strong> ${data.msg}`;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });

    // Listen for system messages (user joined/left) and update listener count
    socket.on('room_message', (data) => {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<em>${data.msg}</em>`;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        
        // Extract listener count from the message and update the span
        const match = data.msg.match(/\((\d+)\slisteners\)/);
        if (match) {
            listenerCountElement.innerHTML = match[1];
        }
    });

    // Handle form submission to send a message
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();
        if (message) {
            socket.emit('send_message', { msg: message, username: username, room_key: roomKey });
            messageInput.value = '';
        }
    });
    
    // Handle button click to leave the room
    leaveRoomButton.addEventListener('click', () => {
        socket.emit('leave', { username: username, room_key: roomKey });
        window.location.href = '/home';
    });

    // Handle leaving the room when the user navigates away
    window.addEventListener('beforeunload', () => {
        socket.emit('leave', { username: username, room_key: roomKey });
    });
});