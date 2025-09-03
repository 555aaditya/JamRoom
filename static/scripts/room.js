document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    
    // Global variables passed from Flask
    const roomKey = ROOM_KEY;
    const username = CURRENT_USER;
    const accessToken = SPOTIFY_ACCESS_TOKEN;

    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages-container');
    const listenerCountElement = document.getElementById('listener-count');
    const leaveRoomButton = document.getElementById('leave-room-button');

    // Music search elements
    const musicSearchInput = document.getElementById('music-search-input');
    const musicResultsContainer = document.getElementById('music-results-container');
    
    // Music player elements
    const playPauseButton = document.getElementById('play-pause-btn');
    const prevButton = document.getElementById('prev-btn');
    const nextButton = document.getElementById('next-btn');
    const playerArtwork = document.getElementById('player-artwork');
    const playerCurrentTrack = document.getElementById('player-current-track');
    const playerStatus = document.getElementById('player-status'); // New status element
    const progressBar = document.getElementById('progress');
    const progressContainer = document.querySelector('.progress-bar');
    const currentTimeElement = document.getElementById('current-time');
    const durationElement = document.getElementById('duration');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeDisplay = document.getElementById('volume-display');
    
    // Spotify Web Playback SDK Player and State
    let player = null;
    let deviceId = null;
    let currentTrack = null;
    const DEFAULT_ARTWORK = typeof DEFAULT_ARTWORK_URL !== 'undefined' ? DEFAULT_ARTWORK_URL : '';

    // Initialize Spotify Web Playback SDK
    window.onSpotifyWebPlaybackSDKReady = () => {
        if (!accessToken) {
            playerStatus.textContent = "Please connect to Spotify on the home page.";
            return;
        }

        player = new Spotify.Player({
            name: 'JamRoom Music Player',
            getOAuthToken: cb => { cb(accessToken); },
            volume: 0.7
        });

        // SDK Player Events
        player.addListener('ready', ({ device_id }) => {
            console.log('Ready with Device ID', device_id);
            deviceId = device_id;
            playerStatus.textContent = "Player ready!";
        });

        player.addListener('not_ready', ({ device_id }) => {
            console.log('Device ID has gone offline', device_id);
            playerStatus.textContent = "Player offline. Please refresh.";
        });

        player.addListener('initialization_error', ({ message }) => {
            console.error('Failed to initialize:', message);
            playerStatus.textContent = "Initialization error. Please try again.";
        });
        player.addListener('authentication_error', ({ message }) => {
            console.error('Authentication error:', message);
            playerStatus.textContent = "Authentication error. Please re-link your Spotify account on the home page.";
        });

        player.addListener('playback_error', ({ message }) => {
            console.error('Playback error:', message);
            playerStatus.textContent = "Playback error. Try playing another song.";
        });

        // Player state change events
        player.addListener('player_state_changed', (state) => {
            if (!state || !state.track_window.current_track) {
                currentTrack = null;
                playerArtwork.src = DEFAULT_ARTWORK;
                playerCurrentTrack.textContent = 'Current Track: [No track playing]';
                playPauseButton.textContent = '▶️';
                progressBar.style.width = '0%';
                currentTimeElement.textContent = '0:00';
                durationElement.textContent = '0:00';
                return;
            }
            
            const track = state.track_window.current_track;
            currentTrack = track;
            playerArtwork.src = track.album.images[0].url;
            playerCurrentTrack.textContent = `${track.name} - ${track.artists[0].name}`;
            playPauseButton.textContent = state.paused ? '▶️' : '⏸️';

            // Update progress and duration
            const durationMs = state.duration;
            const positionMs = state.position;
            const progress = (positionMs / durationMs) * 100;
            progressBar.style.width = `${progress}%`;
            currentTimeElement.textContent = formatTime(positionMs / 1000);
            durationElement.textContent = formatTime(durationMs / 1000);
        });

        player.connect().then(success => {
            if (success) {
                console.log('The Web Playback SDK successfully connected to Spotify!');
            }
        });
    };

    // Helper function to play a song using the SDK
    const playSong = (songUri) => {
        if (!player || !deviceId) {
            console.error('Player not ready or device ID not available.');
            playerStatus.textContent = 'Player not ready. Please wait or refresh the page.';
            return;
        }

        fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
            method: 'PUT',
            body: JSON.stringify({ uris: [songUri] }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        }).then(response => {
            if (!response.ok) {
                // If playback fails, try to transfer playback
                if (response.status === 404) {
                    transferPlayback(songUri);
                } else {
                    console.error('Error playing song:', response.statusText);
                    playerStatus.textContent = `Error playing song. Status: ${response.status}`;
                }
            }
        }).catch(error => {
            console.error('Fetch error:', error);
            playerStatus.textContent = 'An error occurred. Please check your network.';
        });
    };

    // Helper function to transfer playback to our SDK player
    const transferPlayback = (songUri) => {
        fetch('https://api.spotify.com/v1/me/player', {
            method: 'PUT',
            body: JSON.stringify({ 
                device_ids: [deviceId], 
                play: true 
            }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        }).then(response => {
            if (response.ok) {
                // Now that playback is on the correct device, play the song
                playSong(songUri);
            } else {
                console.error('Failed to transfer playback:', response.statusText);
                playerStatus.textContent = 'Failed to transfer playback. Please ensure Spotify is open on another device.';
            }
        }).catch(error => {
            console.error('Transfer playback fetch error:', error);
            playerStatus.textContent = 'An error occurred while transferring playback.';
        });
    };


    // Play/Pause functionality
    if (playPauseButton) {
        playPauseButton.addEventListener('click', () => {
            if (player) {
                player.togglePlay();
            }
        });
    }

    // Previous/Next button functionality
    if (prevButton) prevButton.addEventListener('click', () => player.previousTrack());
    if (nextButton) nextButton.addEventListener('click', () => player.nextTrack());

    // Progress bar click to seek
    if (progressContainer) {
        progressContainer.addEventListener('click', (e) => {
            if (player && currentTrack) {
                const rect = progressContainer.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const width = rect.width;
                const clickPosition = (clickX / width);
                const seekToMs = Math.round(clickPosition * currentTrack.duration_ms);
                player.seek(seekToMs);
            }
        });
    }

    // Volume control
    if (volumeSlider) {
        volumeSlider.addEventListener('input', (e) => {
            const volume = e.target.value / 100;
            if (player) {
                player.setVolume(volume);
                volumeDisplay.textContent = `${e.target.value}%`;
            }
        });
    }
    
    // Helper function to format time
    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    // Music search logic
    if (musicSearchInput && musicResultsContainer) {
        let searchTimeoutId = null;

        const renderResults = (songs) => {
            musicResultsContainer.innerHTML = '';
            if (!songs || songs.length === 0) {
                musicResultsContainer.innerHTML = '<p>No results found.</p>';
                return;
            }
            songs.forEach(song => {
                const card = document.createElement('div');
                card.className = 'music-card';
                card.dataset.songUri = song.uri; // Use the URI for playback
                card.dataset.songTitle = song.title; // For display

                card.innerHTML = `
                    <p class="song-title">${song.title || 'Unknown Title'}</p>
                    <p class="song-artist">${song.artist || 'Unknown Artist'}</p>
                `;
                
                card.addEventListener('click', () => {
                    const songUri = card.dataset.songUri;
                    if (songUri) {
                        // Play the song via SDK and then emit to room
                        playSong(songUri);
                        socket.emit('song_play', {
                            song: {
                                uri: songUri,
                                title: card.dataset.songTitle,
                                artist: card.querySelector('.song-artist').textContent,
                                artwork: song.artwork // Pass artwork for sync
                            },
                            room_key: roomKey
                        });
                    }
                });
                musicResultsContainer.appendChild(card);
            });
        };

        const fetchResults = (q) => {
            if (!q) { musicResultsContainer.innerHTML = ''; return; }
            fetch(`/api/search?q=${encodeURIComponent(q)}`)
                .then(r => {
                    if (!r.ok) {
                        throw new Error(`HTTP error! status: ${r.status}`);
                    }
                    return r.json();
                })
                .then(renderResults)
                .catch(error => { 
                    console.error('Error fetching music:', error);
                    musicResultsContainer.innerHTML = '<p>Failed to load music results.</p>'; 
                });
        };

        musicSearchInput.addEventListener('keyup', (e) => {
            const q = e.target.value.trim();
            clearTimeout(searchTimeoutId);
            searchTimeoutId = setTimeout(() => fetchResults(q), 500);
        });
    }

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
        
        const match = data.msg.match(/\((\d+)\slisteners\)/);
        if (match) {
            listenerCountElement.innerHTML = match[1];
        }
    });

    // Listen for synchronized music events
    socket.on('song_play', (data) => {
        if (player && deviceId) {
            // Play the song for all other users
            playSong(data.song.uri);
            // Update the UI for other users
            playerCurrentTrack.textContent = `${data.song.title} - ${data.song.artist}`;
            playerArtwork.src = data.song.artwork;
        }
    });

    // Handle button click to leave the room
    leaveRoomButton.addEventListener('click', () => {
        if (player) {
            player.disconnect(); // Disconnect Spotify player
        }
        // Emit the leave event
        socket.emit('leave', { username: username, room_key: roomKey });
        
        // Add a small delay to allow the socket message to be sent before redirecting
        setTimeout(() => {
            window.location.href = '/home';
        }, 150);
    });
});