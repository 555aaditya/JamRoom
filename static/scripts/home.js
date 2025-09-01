document.addEventListener('DOMContentLoaded', () => {
    const publicRoomsRow1 = document.getElementById('public-rooms-row-1');
    const publicRoomsRow2 = document.getElementById('public-rooms-row-2');

    // This is the correct endpoint from your uploaded image_94ec23.png
    fetch('/api/public-rooms')
      .then(response => {
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        return response.json();
      })
      .then(data => {
        if (data && data.length > 0) {
          data.forEach((room, index) => {
            const roomCard = document.createElement('div'); // Use div instead of <a> for better control
            roomCard.classList.add('room-card');
            
            // Calculate card width based on room name length - ensure it's wide enough for one line
            const roomName = room.name || 'Unnamed Room';
            const minWidth = 280; // Minimum width for readability
            const charWidth = 16; // More accurate width per character
            const padding = 100; // Extra padding for button and spacing
            const cardWidth = Math.max(minWidth, roomName.length * charWidth + padding);
            
            roomCard.style.width = `${cardWidth}px`;
            roomCard.style.flexShrink = '0'; // Prevent cards from shrinking
            
            roomCard.innerHTML = `
              <div class="room-card-content">
                <h3 class="room-name">${roomName}</h3>
                <p class="room-owner">Owner: ${room.creator || 'Unknown'}</p>
                <p class="room-listeners">Listeners: ${room.listeners || 0}</p>
                <button class="join-btn" onclick="window.location.href='/room/${room.room_key}'">Join</button>
              </div>
            `;
            
            // Distribute cards evenly between the two rows
            if (index % 2 === 0) {
              publicRoomsRow1.appendChild(roomCard);
            } else {
              publicRoomsRow2.appendChild(roomCard);
            }
          });
        }
      })
      .catch(error => console.error('Error fetching public rooms:', error));
});

document.addEventListener('DOMContentLoaded', () => {
    // Other form submission handlers to prevent default behavior on empty fields
    const createPublicRoomForm = document.getElementById('create-public-room-form');
    const joinRoomForm = document.getElementById('join-room-form');
    const createPrivateRoomForm = document.getElementById('create-private-room-form');

    createPublicRoomForm.addEventListener('submit', (e) => {
        const roomNameInput = e.target.querySelector('input[name="room_name"]');
        const roomName = roomNameInput.value.trim();
        if (!roomName) {
            e.preventDefault();
            alert('Room name is required.');
        }
    });

    joinRoomForm.addEventListener('submit', async (e) => {
        e.preventDefault(); // Prevent default form submission
        
        const roomKeyInput = e.target.querySelector('input[name="room_key"]');
        const roomKey = roomKeyInput.value.trim();
        
        if (!roomKey) {
            alert('Room code is required.');
            return;
        }

        try {
            const response = await fetch('/join-room', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ room_key: roomKey })
            });

            const data = await response.json();
            
            if (response.ok && data.redirect_url) {
                window.location.href = data.redirect_url;
            } else {
                alert(data.error || 'Failed to join room');
            }
        } catch (error) {
            console.error('Error joining room:', error);
            alert('An error occurred while joining the room');
        }
    });

    createPrivateRoomForm.addEventListener('submit', (e) => {
        const roomNameInput = e.target.querySelector('input[name="room_name"]');
        const roomName = roomNameInput.value.trim();
        if (!roomName) {
            e.preventDefault();
            alert('Room name is required.');
        }
    });
});