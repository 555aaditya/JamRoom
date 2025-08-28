document.addEventListener('DOMContentLoaded', () => {
    const roomsContainer = document.getElementById('public-rooms-container');

    const fetchRooms = () => {
        fetch('/api/public-rooms')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(rooms => {
                roomsContainer.innerHTML = '';
                
                rooms.forEach(room => {
                    const roomCard = document.createElement('div');
                    roomCard.className = 'room-card';

                    roomCard.innerHTML = `
                        <h3>${room.name}</h3>
                        <p>Code: ${room.room_key}</p>
                        <p>${room.listeners || 0} listeners</p>
                        <button class="join-btn" data-room-key="${room.room_key}">Join</button>
                    `;

                    roomsContainer.appendChild(roomCard);
                });

                document.querySelectorAll('.join-btn').forEach(button => {
                    button.addEventListener('click', (event) => {
                        const roomKey = event.target.dataset.roomKey;
                        window.location.href = `/room/${roomKey}`;
                    });
                });
            })
            .catch(error => {
                console.error('Failed to fetch public rooms:', error);
                roomsContainer.innerHTML = '<p>Error loading rooms. Please try again later.</p>';
            });
    };

    fetchRooms();
});