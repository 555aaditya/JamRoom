document.addEventListener('DOMContentLoaded', () => {
    // ------------------- INITIALIZATION & SCOPE -------------------
    console.log('DOM Content Loaded. Initializing script.');
    const socket = io();
    
    // Global variables passed from Flask
    const roomKey = ROOM_KEY;
    const username = CURRENT_USER;
    const accessToken = SPOTIFY_ACCESS_TOKEN;
    const DEFAULT_ARTWORK = typeof DEFAULT_ARTWORK_URL !== 'undefined' ? DEFAULT_ARTWORK_URL : '';

    // HTML Elements
    const musicSearchInput = document.getElementById('music-search-input');
    const musicResultsContainer = document.getElementById('music-results-container');
    const playPauseButton = document.getElementById('play-pause-btn');
    const prevButton = document.getElementById('prev-btn');
    const nextButton = document.getElementById('next-btn');
    const playerArtwork = document.getElementById('player-artwork');
    const playerCurrentTrack = document.getElementById('player-current-track');
    const playerStatus = document.getElementById('player-status');
    const progressBar = document.getElementById('progress');
    const progressContainer = document.querySelector('.progress-bar');
    const currentTimeElement = document.getElementById('current-time');
    const durationElement = document.getElementById('duration');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeDisplay = document.getElementById('volume-display');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages-container');
    const listenerCountElement = document.getElementById('listener-count');
    const leaveRoomButton = document.getElementById('leave-room-button');
    
    // Spotify Web Playback SDK Player and State
    let player = null;
    let deviceId = null;
    let currentTrack = null;
    let currentPlaylist = []; // This will be your song queue
    let isPlayingSource = false;
    let progressUpdateInterval = null; // Timer for progress updates
    
    // Rate limiting and deduplication
    let lastPlayedSongUri = null;
    let lastPlayTime = 0;
    let isProcessingPlayback = false;
    let broadcastProtectionTime = 0; // Time when we last broadcasted, for protection
    let restorationAttempts = 0; // Counter for playback restoration attempts
    const PLAY_COOLDOWN = 2000; // 2 seconds between play requests

    // ------------------- SPOTIFY WEB PLAYBACK SDK -------------------
    window.onSpotifyWebPlaybackSDKReady = () => {
        console.log('Spotify Web Playback SDK is ready.');
        if (!accessToken) {
            console.error('No Spotify access token available.');
            playerStatus.textContent = "Please connect to Spotify on the home page.";
            return;
        }

        player = new Spotify.Player({
            name: 'JamRoom Music Player',
            getOAuthToken: cb => { 
                console.log('Requesting OAuth token for SDK.');
                cb(accessToken); 
            },
            volume: 0.7
        });
        
        player.addListener('ready', ({ device_id }) => {
            console.log('Ready with Device ID', device_id);
            deviceId = device_id;
            playerStatus.textContent = "Player ready!";
            // Request playback sync from the server
            socket.emit('sync_request', { room_key: roomKey });
            console.log('Emitted sync_request to server.');
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

            player.addListener('player_state_changed', (state) => {
        console.log('=== PLAYER STATE CHANGED ===');
        console.log('State received:', state);
        console.log('Current isPlayingSource:', isPlayingSource);
        console.log('Current track before update:', currentTrack?.name);
        
        if (!state || !state.track_window.current_track) {
            console.log('❌ PLAYBACK STOPPED - No track playing');
            console.log('Reason: state is null or no current track');
            console.log('State was:', state);
            console.log('Track window was:', state?.track_window);
            console.log('Current isPlayingSource:', isPlayingSource);
            console.log('Current track before reset:', currentTrack?.name);
            
            // If the original user's playback stops, try to restore it
            if (isPlayingSource && currentTrack && currentTrack.uri && restorationAttempts < 3) {
                restorationAttempts++;
                console.log(`🔄 Original user playback stopped - attempting to restore (attempt ${restorationAttempts}/3)...`);
                console.log('Restoring track:', currentTrack.name, 'URI:', currentTrack.uri);
                
                // Restore playback after a short delay
                setTimeout(() => {
                    console.log('🔄 Attempting to restore original user playback...');
                    console.log('Current isPlayingSource before restoration:', isPlayingSource);
                    console.log('Current track before restoration:', currentTrack?.name);
                    
                    // Ensure we maintain source status during restoration
                    const wasPlayingSource = isPlayingSource;
                    const trackToRestore = currentTrack;
                    
                    if (wasPlayingSource && trackToRestore) {
                        console.log('✅ Maintaining source status during restoration');
                        playSong(trackToRestore.uri, 0, true); // Skip emit to prevent loops
                    } else {
                        console.log('❌ Cannot restore - lost source status or track info');
                    }
                }, 1000);
                
                // Don't reset UI yet - wait to see if restoration works
                console.log('⏳ Waiting for playback restoration...');
                return;
            } else if (isPlayingSource && restorationAttempts >= 3) {
                console.log('❌ Maximum restoration attempts reached - giving up');
                restorationAttempts = 0; // Reset counter
            }
            
            // If playback stops for listener users, try to restore it as well
            if (!isPlayingSource && currentTrack && currentTrack.uri && restorationAttempts < 3) {
                restorationAttempts++;
                console.log(`🔄 Listener user playback stopped - attempting to restore (attempt ${restorationAttempts}/3)...`);
                console.log('Restoring track:', currentTrack.name, 'URI:', currentTrack.uri);
                
                // Restore playback after a short delay
                setTimeout(() => {
                    console.log('🔄 Attempting to restore listener user playback...');
                    console.log('Current isPlayingSource before restoration:', isPlayingSource);
                    console.log('Current track before restoration:', currentTrack?.name);
                    
                    // Ensure we maintain listener status during restoration
                    const wasPlayingSource = isPlayingSource;
                    const trackToRestore = currentTrack;
                    
                    if (!wasPlayingSource && trackToRestore) {
                        console.log('✅ Maintaining listener status during restoration');
                        playSong(trackToRestore.uri, 0, true); // Skip emit to prevent loops
                    } else {
                        console.log('❌ Cannot restore - lost listener status or track info');
                    }
                }, 1000);
                
                // Don't reset UI yet - wait to see if restoration works
                console.log('⏳ Waiting for playback restoration...');
                return;
            } else if (!isPlayingSource && restorationAttempts >= 3) {
                console.log('❌ Maximum restoration attempts reached for listener - giving up');
                restorationAttempts = 0; // Reset counter
            }
            
            // If playback stops and restoration fails, reset the UI
            console.log('🔄 Resetting UI for stopped playback');
            currentTrack = null;
            stopProgressUpdates();
            playerArtwork.src = DEFAULT_ARTWORK;
            playerCurrentTrack.textContent = 'Current Track: [No track playing]';
            playPauseButton.textContent = '▶️';
            progressBar.style.width = '0%';
            currentTimeElement.textContent = '0:00';
            durationElement.textContent = '0:00';
            console.log('✅ UI reset completed for stopped playback');
            return;
        }
        
        const track = state.track_window.current_track;
        console.log('🎵 Track playing:', track.name, 'by', track.artists[0].name);
        console.log('⏸️ Paused:', state.paused);
        console.log('⏱️ Position:', state.position, 'ms /', state.duration, 'ms');
        
        currentTrack = track;
        playerArtwork.src = track.album.images[0].url;
        playerCurrentTrack.textContent = `${track.name} - ${track.artists[0].name}`;
        playPauseButton.textContent = state.paused ? '▶️' : '⏸️';
    
        // Start progress updates when a track starts playing
        if (!state.paused) {
            console.log('▶️ Starting progress updates (track is playing)');
            startProgressUpdates();
        } else {
            console.log('⏸️ Track is paused, not starting progress updates');
        }
        
        // If this client is the playback source, emit state changes to the server
        if (isPlayingSource) {
            console.log('📡 This client is the source, emitting song_update to server');
            socket.emit('song_update', {
                room_key: roomKey,
                state: {
                    is_paused: state.paused,
                    track_uri: track.uri,
                    position_ms: state.position,
                    duration_ms: state.duration,
                    track_info: {
                        title: track.name,
                        artist: track.artists[0].name,
                        artwork: track.album.images[0].url,
                        album: track.album.name,
                        duration: track.duration_ms
                    }
                }
            });
            console.log('✅ song_update emitted to server');
        } else {
            console.log('👂 This client is NOT the source, not emitting song_update');
        }
        console.log('=== END PLAYER STATE CHANGED ===');
    });

        player.connect().then(success => {
            if (success) {
                console.log('The Web Playback SDK successfully connected to Spotify!');
            }
        });
    };
    
    // ------------------- PLAYBACK CONTROLS & LOGIC -------------------
    const playSong = (songUri, position_ms = 0, skipEmit = false) => {
        console.log('=== PLAYSONG CALLED ===');
        console.log(`🎵 Song URI: ${songUri}`);
        console.log(`⏱️ Position: ${position_ms}ms`);
        console.log(`🚫 Skip Emit: ${skipEmit}`);
        console.log(`🎯 Is Playing Source: ${isPlayingSource}`);
        console.log(`🔄 Is Processing: ${isProcessingPlayback}`);
        console.log(`⏰ Last Play Time: ${lastPlayTime}`);
        console.log(`🎵 Last Played URI: ${lastPlayedSongUri}`);
        
        // Rate limiting check (more lenient for restoration attempts)
        const now = Date.now();
        const cooldown = skipEmit ? 500 : PLAY_COOLDOWN; // Shorter cooldown for restoration
        if (now - lastPlayTime < cooldown) {
            console.log('❌ RATE LIMITED: Too soon since last play request');
            console.log(`Time since last play: ${now - lastPlayTime}ms (cooldown: ${cooldown}ms)`);
            return;
        }
        
        // Deduplication check
        if (lastPlayedSongUri === songUri && now - lastPlayTime < PLAY_COOLDOWN) {
            console.log('❌ DEDUPLICATION: Same song played recently, skipping');
            console.log(`Same URI: ${lastPlayedSongUri === songUri}`);
            console.log(`Time since last play: ${now - lastPlayTime}ms`);
            return;
        }
        
        if (!player || !deviceId) {
            console.error('❌ PLAYER NOT READY');
            console.log(`Player exists: ${!!player}`);
            console.log(`Device ID exists: ${!!deviceId}`);
            console.log(`Device ID: ${deviceId}`);
            playerStatus.textContent = 'Player not ready. Please wait or refresh the page.';
            return;
        }

        if (isProcessingPlayback) {
            console.log('❌ ALREADY PROCESSING: Another playback request in progress');
            return;
        }

        console.log('✅ All checks passed, starting playback...');
        isProcessingPlayback = true;
        lastPlayTime = now;
        lastPlayedSongUri = songUri;
        console.log(`🔄 Set isProcessingPlayback to: ${isProcessingPlayback}`);
        console.log(`⏰ Updated lastPlayTime to: ${lastPlayTime}`);
        console.log(`🎵 Updated lastPlayedSongUri to: ${lastPlayedSongUri}`);

        console.log('🌐 Making Spotify API request...');
        console.log(`URL: https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`);
        console.log(`Body: ${JSON.stringify({ uris: [songUri], position_ms })}`);
        
        fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
            method: 'PUT',
            body: JSON.stringify({ uris: [songUri], position_ms }),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => {
            console.log('📡 Spotify API response received');
            console.log(`Status: ${response.status} ${response.statusText}`);
            console.log(`OK: ${response.ok}`);
            
            isProcessingPlayback = false;
            console.log(`🔄 Set isProcessingPlayback to: ${isProcessingPlayback}`);
            
            if (!response.ok) {
                console.error('❌ SPOTIFY API ERROR');
                console.error(`Status: ${response.status}`);
                console.error(`Status Text: ${response.statusText}`);
                
                if (response.status === 429) {
                    console.log('⏰ Rate limited by Spotify - applying 10 second penalty');
                    playerStatus.textContent = 'Rate limited by Spotify. Please wait a moment.';
                    // Increase cooldown for rate limit
                    lastPlayTime = now + 10000; // 10 second penalty
                    console.log(`⏰ Updated lastPlayTime to: ${lastPlayTime} (with penalty)`);
                } else {
                    console.log(`❌ Other error: ${response.status}`);
                    playerStatus.textContent = `Error playing song. Status: ${response.status}`;
                }
            } else {
                console.log('✅ SPOTIFY API SUCCESS - Playback started successfully');
                playerStatus.textContent = 'Playing...';
                
                // Only emit the event if the song was successfully started AND we're not skipping emit
                if (!skipEmit && isPlayingSource) {
                    console.log('📡 Original user: Playback successful, emitting song_play event to other users');
                    console.log(`skipEmit: ${skipEmit}, isPlayingSource: ${isPlayingSource}`);
                    
                    // Add a small delay to ensure the original user's playback is stable before broadcasting
                    console.log('⏳ Adding 500ms delay to ensure playback stability before broadcasting...');
                    setTimeout(() => {
                        console.log('🔄 Delay completed, checking playback stability...');
                        
                        // Verify that the original user is still the source and playback is stable
                        if (!isPlayingSource) {
                            console.log('❌ isPlayingSource changed during delay - aborting broadcast');
                            return;
                        }
                        
                        // Check if we still have a current track
                        if (!currentTrack) {
                            console.log('❌ No current track during delay - aborting broadcast');
                            return;
                        }
                        
                        console.log('✅ Playback stability confirmed, proceeding with broadcast');
                        
                        // Get detailed track information and emit
                        console.log('🔍 Getting detailed track information...');
                        getTrackDetails(songUri).then(trackDetails => {
                            console.log('📋 Track details received:', trackDetails);
                            const trackInfo = trackDetails || currentTrack;
                            console.log('📋 Using track info:', trackInfo);
                            
                            if (trackInfo) {
                                // Update current track with complete information
                                console.log('🔄 Updating currentTrack with complete information');
                                currentTrack = trackInfo;
                                
                                // Update UI with complete track info
                                console.log('🎨 Updating UI with complete track info');
                                playerCurrentTrack.textContent = `${trackInfo.name} - ${trackInfo.artists?.[0]?.name}`;
                                playerArtwork.src = trackInfo.album?.images?.[0]?.url || DEFAULT_ARTWORK;
                                
                                console.log('📡 Original user: Emitting song_play with track info:', trackInfo.name);
                                socket.emit('song_play', {
                                    song: {
                                        uri: songUri,
                                        title: trackInfo.name || 'Unknown',
                                        artist: trackInfo.artists?.[0]?.name || 'Unknown',
                                        artwork: trackInfo.album?.images?.[0]?.url || DEFAULT_ARTWORK,
                                        album: trackInfo.album?.name || 'Unknown Album',
                                        duration: trackInfo.duration_ms || 0
                                    },
                                    room_key: roomKey,
                                    position_ms: 0
                                });
                                console.log('✅ song_play event emitted to server');
                                
                                // Set protection time to ignore any incoming song_play events for 5 seconds
                                broadcastProtectionTime = Date.now();
                                console.log(`🛡️ Set broadcast protection until: ${new Date(broadcastProtectionTime + 5000).toLocaleTimeString()}`);
                                
                                // Add additional protection: temporarily disable any song_play_sync event processing
                                console.log('🔒 Original user is now completely isolated from server events');
                            } else {
                                console.log('❌ No track info available to emit');
                            }
                        }).catch(error => {
                            console.error('❌ Error getting track details:', error);
                        });
                    }, 500); // 500ms delay to ensure playback stability
                } else {
                    console.log('🚫 Not emitting song_play event');
                    console.log(`Reason - skipEmit: ${skipEmit}, isPlayingSource: ${isPlayingSource}`);
                }
            }
        })
        .catch(error => {
            console.error('❌ FETCH ERROR');
            console.error('Error details:', error);
            isProcessingPlayback = false;
            console.log(`🔄 Set isProcessingPlayback to: ${isProcessingPlayback}`);
            playerStatus.textContent = 'An error occurred. Please check your network.';
        });
        
        console.log('=== END PLAYSONG CALLED ===');
    };

    if (playPauseButton) {
        playPauseButton.addEventListener('click', () => {
            console.log('Play/Pause button clicked.');
            if (player) {
                player.getCurrentState().then(state => {
                    player.togglePlay();
                    if (state) {
                        console.log(`Emitting player_toggle_play. is_paused: ${!state.paused}, position_ms: ${state.position}`);
                        socket.emit('player_toggle_play', {
                            room_key: roomKey,
                            is_paused: !state.paused,
                            position_ms: state.position
                        });
                    }
                });
            }
        });
    }

    // Previous/Next button functionality
    if (prevButton) prevButton.addEventListener('click', () => {
        console.log('Previous button clicked.');
        if (player) {
            player.previousTrack();
            player.getCurrentState().then(state => {
                if (state) {
                    console.log(`Emitting player_toggle_play for previous track.`);
                    socket.emit('player_toggle_play', {
                        room_key: roomKey,
                        is_paused: state.paused,
                        position_ms: state.position
                    });
                }
            });
        }
    });
    if (nextButton) nextButton.addEventListener('click', () => {
        console.log('Next button clicked.');
        if (player) {
            player.nextTrack();
            player.getCurrentState().then(state => {
                if (state) {
                    console.log(`Emitting player_toggle_play for next track.`);
                    socket.emit('player_toggle_play', {
                        room_key: roomKey,
                        is_paused: state.paused,
                        position_ms: state.position
                    });
                }
            });
        }
    });

    // Progress bar click to seek
    if (progressContainer) {
        progressContainer.addEventListener('click', (e) => {
            console.log('Progress bar clicked.');
            if (player && currentTrack) {
                const rect = progressContainer.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const width = rect.width;
                const clickPosition = (clickX / width);
                const seekToMs = Math.round(clickPosition * currentTrack.duration_ms);
                player.seek(seekToMs);
                console.log(`Emitting player_seek to position: ${seekToMs}`);
                socket.emit('player_seek', {
                    room_key: roomKey,
                    position_ms: seekToMs
                });
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

    // Function to update progress bar and time display
    function updateProgress() {
        if (player && currentTrack) {
            player.getCurrentState().then(state => {
                if (state && state.track_window.current_track) {
                    const progress = (state.position / state.duration) * 100;
                    progressBar.style.width = `${progress}%`;
                    currentTimeElement.textContent = formatTime(state.position / 1000);
                    durationElement.textContent = formatTime(state.duration / 1000);
                    
                    // Update play/pause button state
                    playPauseButton.textContent = state.paused ? '▶️' : '⏸️';
                    
                    // Log progress every 10 seconds to avoid spam
                    if (Math.floor(state.position / 1000) % 10 === 0) {
                        console.log(`⏱️ Progress Update: ${formatTime(state.position / 1000)} / ${formatTime(state.duration / 1000)} (${progress.toFixed(1)}%) - ${state.paused ? 'PAUSED' : 'PLAYING'}`);
                    }
                } else {
                    console.log('⚠️ Progress update: No current track in state');
                }
            }).catch(error => {
                console.error('❌ Error getting current state for progress update:', error);
            });
        } else {
            console.log('⚠️ Progress update skipped - player or currentTrack not available');
            console.log(`Player exists: ${!!player}, Current track exists: ${!!currentTrack}`);
        }
    }

    // Function to start progress updates
    function startProgressUpdates() {
        console.log('🔄 Starting progress updates...');
        if (progressUpdateInterval) {
            console.log('⚠️ Clearing existing progress update interval');
            clearInterval(progressUpdateInterval);
        }
        progressUpdateInterval = setInterval(updateProgress, 1000); // Update every 1 second
        console.log('✅ Started progress updates every 1 second');
        console.log(`Interval ID: ${progressUpdateInterval}`);
    }

    // Function to stop progress updates
    function stopProgressUpdates() {
        console.log('🛑 Stopping progress updates...');
        if (progressUpdateInterval) {
            console.log(`Clearing interval ID: ${progressUpdateInterval}`);
            clearInterval(progressUpdateInterval);
            progressUpdateInterval = null;
            console.log('✅ Stopped progress updates');
        } else {
            console.log('ℹ️ No progress update interval to stop');
        }
    }

    // Function to get detailed track information from Spotify API
    function getTrackDetails(trackUri) {
        console.log('🔍 Getting detailed track information...');
        console.log(`Track URI: ${trackUri}`);
        console.log(`Access token available: ${!!accessToken}`);
        
        if (!trackUri || !accessToken) {
            console.log('❌ Cannot get track details - missing URI or access token');
            return Promise.resolve(null);
        }
        
        const trackId = trackUri.replace('spotify:track:', '');
        console.log(`Track ID extracted: ${trackId}`);
        console.log(`API URL: https://api.spotify.com/v1/tracks/${trackId}`);
        
        return fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        })
        .then(response => {
            console.log(`Track details API response: ${response.status} ${response.statusText}`);
            if (response.ok) {
                return response.json();
            } else {
                console.log('❌ Track details API error:', response.status);
                return null;
            }
        })
        .then(data => {
            if (data) {
                console.log('✅ Track details received:', data.name, 'by', data.artists?.[0]?.name);
            } else {
                console.log('❌ No track details data received');
            }
            return data;
        })
        .catch(error => {
            console.error('❌ Error fetching track details:', error);
            return null;
        });
    }

    // ------------------- MUSIC SEARCH LOGIC -------------------
    if (musicSearchInput && musicResultsContainer) {
        let searchTimeoutId = null;

        const renderResults = (songs) => {
            console.log('Rendering music search results:', songs);
            musicResultsContainer.innerHTML = '';
            if (!songs || songs.length === 0) {
                musicResultsContainer.innerHTML = '<p>No results found.</p>';
                return;
            }
            songs.forEach(song => {
                const card = document.createElement('div');
                card.className = 'music-card';
                card.dataset.songUri = song.uri;
                card.dataset.songTitle = song.title;
                card.dataset.songArtist = song.artist;
                card.dataset.songArtwork = song.artwork;
                
                card.innerHTML = `
                    <p class="song-title">${song.title || 'Unknown Title'}</p>
                    <p class="song-artist">${song.artist || 'Unknown Artist'}</p>
                `;
                
                card.addEventListener('click', () => {
                    console.log('=== SEARCH RESULT CARD CLICKED ===');
                    console.log('🖱️ Search result card clicked');
                    
                    const songUri = card.dataset.songUri;
                    const songTitle = card.dataset.songTitle;
                    const songArtist = card.dataset.songArtist;
                    const songArtwork = card.dataset.songArtwork;
                    
                    console.log('📋 Card data extracted:');
                    console.log(`🎵 Song URI: ${songUri}`);
                    console.log(`📝 Song Title: ${songTitle}`);
                    console.log(`🎤 Song Artist: ${songArtist}`);
                    console.log(`🖼️ Song Artwork: ${songArtwork}`);
                    
                    if (songUri) {
                        console.log('✅ Valid song URI found, proceeding with playback');
                        console.log('🎯 Setting this client as the playback source');
                        console.log(`Previous isPlayingSource: ${isPlayingSource}`);
                        
                        isPlayingSource = true; // Set this client as the source before playing
                        restorationAttempts = 0; // Reset restoration counter for new song
                        console.log(`New isPlayingSource: ${isPlayingSource}`);
                        console.log('🔄 Reset restoration counter for new song');
                        
                        // Store track info for immediate UI update
                        console.log('💾 Storing track info for immediate UI update');
                        currentTrack = {
                            uri: songUri,
                            name: songTitle,
                            artists: [{ name: songArtist }],
                            album: {
                                name: 'Unknown Album',
                                images: [{ url: songArtwork }]
                            },
                            duration_ms: 0
                        };
                        console.log('✅ Track info stored:', currentTrack);
                        
                        // Update UI immediately
                        console.log('🎨 Updating UI immediately with track info');
                        playerCurrentTrack.textContent = `${songTitle} - ${songArtist}`;
                        playerArtwork.src = songArtwork || DEFAULT_ARTWORK;
                        console.log('✅ UI updated with track title and artwork');
                        
                        console.log('🚀 Original user starting playback with track info:', currentTrack);
                        console.log('🎯 isPlayingSource set to:', isPlayingSource);
                        
                        playSong(songUri);
                    } else {
                        console.error('❌ No song URI found in card data');
                    }
                    console.log('=== END SEARCH RESULT CARD CLICKED ===');
                });
                musicResultsContainer.appendChild(card);
            });
        };

        const fetchResults = (q) => {
            if (!q) { musicResultsContainer.innerHTML = ''; return; }
            console.log(`Fetching search results for: "${q}"`);
            fetch(`/api/search?q=${encodeURIComponent(q)}`)
                .then(r => {
                    console.log('Search API response received.');
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

    // ------------------- SOCKET.IO EVENT HANDLERS -------------------
    socket.on('connect', () => {
        console.log('Socket.IO connected to server.');
        socket.emit('join', { username: username, room_key: roomKey });
        console.log('Emitted join event.');
    });

    socket.on('new_message', (data) => {
        console.log('Received new_message:', data);
        const messageElement = document.createElement('div');
        messageElement.innerHTML = `<strong>${data.username}:</strong> ${data.msg}`;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });

    socket.on('room_message', (data) => {
        console.log('Received room_message:', data);
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
    socket.on('sync_toggle_play', (data) => {
        console.log('Received sync_toggle_play event:', data);
        if (player) {
            if (data.is_paused) {
                console.log('Pausing player based on sync event.');
                player.pause();
            } else {
                console.log('Playing player based on sync event.');
                // Note: Spotify Web Playback SDK doesn't have a play() method
                // The player automatically resumes when not paused
                console.log('Player should automatically resume when not paused');
            }
        }
    });
    
    socket.on('sync_seek', (data) => {
        console.log('Received sync_seek event:', data);
        if (player) {
            console.log(`Seeking player to position: ${data.position_ms}`);
            player.seek(data.position_ms);
        }
    });

    // Listen for song_play_sync events (from server, excludes original user)
    socket.on('song_play_sync', (data) => {
        console.log('=== SONG_PLAY_SYNC EVENT RECEIVED ===');
        console.log('📡 Received song_play_sync event from server:', data);
        console.log('🎯 Current isPlayingSource status:', isPlayingSource);
        console.log('🎵 Current track before update:', currentTrack?.name);
        console.log('🎵 Received song URI:', data?.song?.uri);
        console.log('🎵 Current track URI:', currentTrack?.uri);
        
        // Check broadcast protection time
        const now = Date.now();
        const timeSinceBroadcast = now - broadcastProtectionTime;
        if (timeSinceBroadcast < 5000) {
            console.log('🛡️ BROADCAST PROTECTION ACTIVE - ignoring song_play_sync event');
            console.log(`Time since broadcast: ${timeSinceBroadcast}ms (protection: 5000ms)`);
            console.log(`Protection expires at: ${new Date(broadcastProtectionTime + 5000).toLocaleTimeString()}`);
            return;
        }
        
        // This event should NEVER reach the original user due to server-side include_self=False
        // But add protection just in case
        if (isPlayingSource) {
            console.log('🚫 This is the original user - song_play_sync should not reach here!');
            console.log('❌ Server-side include_self=False may not be working correctly');
            return;
        }
        
        // Additional protection: if we're currently playing the same song, ignore the event
        if (currentTrack && data?.song?.uri === currentTrack.uri) {
            console.log('🚫 Already playing the same song - ignoring duplicate song_play_sync event');
            console.log(`Current URI: ${currentTrack.uri}, Received URI: ${data?.song?.uri}`);
            return;
        }
        
        console.log('👂 This is NOT the original user - processing song_play_sync event');
        isPlayingSource = false; // A different client is the new source
        console.log('🔄 Set isPlayingSource to false (this user is now a listener)');
        
        // Reset restoration attempts for new song
        restorationAttempts = 0;
        console.log('🔄 Reset restoration attempts for new song');
        
        if (data && data.song && data.song.uri) {
            console.log('✅ Valid song_play_sync data received');
            console.log('🎵 Song URI:', data.song.uri);
            console.log('📝 Song Title:', data.song.title);
            console.log('🎤 Song Artist:', data.song.artist);
            console.log('🖼️ Song Artwork:', data.song.artwork);
            
            // Update UI immediately with received track info
            if (data.song.title && data.song.artist) {
                console.log('🎨 Updating UI with received track info');
                playerCurrentTrack.textContent = `${data.song.title} - ${data.song.artist}`;
                console.log('✅ Track title updated in UI');
            }
            if (data.song.artwork) {
                console.log('🖼️ Updating artwork with received image');
                playerArtwork.src = data.song.artwork;
                console.log('✅ Artwork updated in UI');
            }
            
            console.log('🔄 Other user playing song, syncing playback...');
            // Skip emitting to prevent infinite loops
            playSong(data.song.uri, data.position_ms || 0, true);
        } else {
            console.error('❌ Invalid song_play_sync data received:', data);
            console.log('Data structure:', JSON.stringify(data, null, 2));
        }
        console.log('=== END SONG_PLAY_SYNC EVENT ===');
    });

    socket.on('sync_playback', (data) => {
        console.log('Received sync_playback event:', data);
        if (data && data.track_uri) {
            // Update UI immediately with received track info
            if (data.track_info) {
                playerCurrentTrack.textContent = `${data.track_info.title} - ${data.track_info.artist}`;
                playerArtwork.src = data.track_info.artwork || DEFAULT_ARTWORK;
            }
            
            // Skip emitting to prevent infinite loops
            playSong(data.track_uri, data.position_ms || 0, true);
            
            if (data.is_paused) {
                setTimeout(() => {
                    if (player) {
                        console.log('Pausing player after sync.');
                        player.pause();
                    }
                }, 1000);
            }
        }
    });

    // Handle button click to leave the room
    leaveRoomButton.addEventListener('click', () => {
        console.log('Leave room button clicked.');
        stopProgressUpdates(); // Stop progress updates when leaving
        if (player) {
            player.disconnect();
        }
        socket.emit('leave', { username: username, room_key: roomKey });
        
        setTimeout(() => {
            console.log('Redirecting to home page.');
            window.location.href = '/home';
        }, 150);
    });

    // Clean up progress updates when page is unloaded
    window.addEventListener('beforeunload', () => {
        stopProgressUpdates();
    });
});