'''--------------------------------------------------------IMPORTS--------------------------------------------------------'''

from flask import Flask, request, render_template, session, redirect, url_for, flash, jsonify, get_flashed_messages
from flask_socketio import SocketIO, join_room, leave_room, emit, send
from pymongo import MongoClient
from flask_sqlalchemy import SQLAlchemy
from dotenv import load_dotenv
import random
import string
import os
import re
import datetime
import requests
import base64
import json
import urllib.parse
from collections import defaultdict

# .env file
load_dotenv()

# flask app initialization
app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')

# SocketIO Initialization
socketio = SocketIO(app)

# Global dictionary to store room playback states
# Key: room_key, Value: {'track_uri': str, 'position_ms': int, 'is_paused': bool, 'track_info': dict}
room_states = {}

# Keep track of clients in each room to count listeners
room_listeners = defaultdict(set)

def get_room_users(room_key):
    return len(room_listeners[room_key])

'''--------------------------------------------------------SOCKET-IO-EVENTS--------------------------------------------------------'''

@socketio.on('connect')
def handle_connect():
    print("Client connected")

@socketio.on('disconnect')
def handle_disconnect():
    print("Client disconnected")
    # Clean up internal listener tracking for the disconnected SID
    for room_key, sids in room_listeners.items():
        if request.sid in sids:
            sids.remove(request.sid)
            # You might also want to decrement the database listener count here
            break
    
@socketio.on('join')
def on_join(data):
    username = data['username']
    room_key = data['room_key']
    
    join_room(room_key)
    room_listeners[room_key].add(request.sid)

    room_data = PublicRooms.find_one({'room_key': room_key})
    if room_data:
        PublicRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': 1}})
    else:
        room_data = PrivateRooms.find_one({'room_key': room_key})
        if room_data:
            PrivateRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': 1}})
    
    updated_room_data = PublicRooms.find_one({'room_key': room_key}) or PrivateRooms.find_one({'room_key': room_key})
    updated_listeners = updated_room_data['listeners']
    
    emit('room_message', {'msg': f'{username} has entered the room. ({updated_listeners} listeners)'}, room=room_key)
    # If a playback state exists, sync it to the newly joined client
    if room_key in room_states:
        emit('sync_playback', room_states[room_key], room=request.sid)

@socketio.on('leave')
def on_leave(data):
    username = data['username']
    room_key = data['room_key']
    
    # Remove the user from the room listener set
    if request.sid in room_listeners[room_key]:
        room_listeners[room_key].remove(request.sid)

    room_data = PublicRooms.find_one({'room_key': room_key})
    if room_data:
        PublicRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': -1}})
    else:
        room_data = PrivateRooms.find_one({'room_key': room_key})
        if room_data:
            PrivateRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': -1}})

    leave_room(room_key)

    updated_room_data = PublicRooms.find_one({'room_key': room_key}) or PrivateRooms.find_one({'room_key': room_key})
    updated_listeners = updated_room_data['listeners']

    emit('room_message', {'msg': f'{username} has left the room. ({updated_listeners} listeners)'}, room=room_key)
    
    # If the last person leaves the room, clear the state
    if get_room_users(room_key) == 0:
        if room_key in room_states:
            del room_states[room_key]

@socketio.on('send_message')
def handle_message(data):
    room_key = data['room_key']
    message = data['msg']
    username = data['username']
    
    emit('new_message', {'username': username, 'msg': message}, room=room_key)

@socketio.on('song_play')
def handle_song_play(data):
    room_key = data.get('room_key')
    song = data.get('song')
    sender_sid = request.sid
    
    if not room_key or not song:
        print(f"Invalid song_play data received: {data}")
        return
    
    print(f"Song play event in room {room_key} from sender {sender_sid}: {song.get('title', 'Unknown')} by {song.get('artist', 'Unknown')}")
    
    # Update the room state with the new song
    room_states[room_key] = {
        'track_uri': song.get('uri'),
        'position_ms': 0,
        'is_paused': False,
        'track_info': {
            'title': song.get('title'),
            'artist': song.get('artist'),
            'artwork': song.get('artwork'),
            'album': song.get('album'),
            'duration': song.get('duration')
        }
    }
    
    # Get all users in the room except the sender
    room_sids = room_listeners.get(room_key, set())
    other_sids = room_sids - {sender_sid}
    
    print(f"Room {room_key} has {len(room_sids)} total users: {list(room_sids)}")
    print(f"Sender SID: {sender_sid}")
    print(f"Other SIDs (excluding sender): {list(other_sids)}")
    print(f"Broadcasting to {len(other_sids)} other users in room {room_key}, excluding sender {sender_sid}")
    
    # Broadcast to all users in the room EXCEPT the sender (to avoid interference)
    # Use a different event name to completely isolate the original user
    emit('song_play_sync', {
        'song': song,
        'position_ms': 0
    }, room=room_key, include_self=False)
    
    print(f"✅ Broadcasted song_play to room {room_key} (excluding sender {sender_sid})")
    print(f"📊 Broadcast summary: {len(other_sids)} recipients, sender excluded")

@socketio.on('player_toggle_play')
def handle_player_toggle_play(data):
    room_key = data['room_key']
    is_paused = data['is_paused']
    position_ms = data['position_ms']

    print(f"Received player_toggle_play event in room {room_key}: is_paused={is_paused}, position_ms={position_ms}")
    
    if room_key in room_states:
        room_states[room_key]['is_paused'] = is_paused
        room_states[room_key]['position_ms'] = position_ms
    
    emit('sync_toggle_play', {
        'is_paused': is_paused,
        'position_ms': position_ms
    }, room=room_key, include_self=False)

    print(f"Broadcasted sync_toggle_play to room {room_key}")

@socketio.on('player_seek')
def handle_player_seek(data):
    room_key = data['room_key']
    position_ms = data['position_ms']

    print(f"Received player_seek event in room {room_key}: position_ms={position_ms}")
    
    if room_key in room_states:
        room_states[room_key]['position_ms'] = position_ms
        
    emit('sync_seek', {
        'position_ms': position_ms
    }, room=room_key, include_self=False)
    
    print(f"Broadcasted sync_seek to room {room_key}")

@socketio.on('song_update')
def handle_song_update(data):
    room_key = data['room_key']
    state = data['state']
    
    # Update the server's copy of the room state
    if room_key in room_states:
        room_states[room_key] = state

@socketio.on('sync_request')
def handle_sync_request(data):
    room_key = data.get('room_key')
    if not room_key:
        print("Invalid sync_request: missing room_key")
        return
        
    print(f"Sync request from user in room {room_key}")
    if room_key in room_states:
        state = room_states[room_key]
        print(f"Sending sync data to user: {state}")
        emit('sync_playback', state, room=request.sid) # Send only to the requesting user
    else:
        print(f"No playback state found for room {room_key}")
        emit('sync_playback', None, room=request.sid)

'''--------------------------------------------------------DATABASES--------------------------------------------------------'''

# SQL initialization
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///users.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

# define SQL DataBase
class users(db.Model):
    _id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    # New columns for Spotify tokens
    spotify_access_token = db.Column(db.String(255))
    spotify_refresh_token = db.Column(db.String(255))
    spotify_token_expiry = db.Column(db.DateTime)

    def __init__(self, username, email, password):
        self.username = username
        self.email = email
        self.password_hash = password

# PyMongo initialization
client = MongoClient("mongodb://localhost:27017")
mdb = client.JamRoom

# PyMongo collections
PublicRooms = mdb.PublicRooms
PrivateRooms = mdb.PrivateRooms
Users = mdb.Users

'''--------------------------------------------------------SPOTIFY-INITIALIZATION--------------------------------------------------------'''

# Spotify API credentials 
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID')
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET')
SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:4444/spotify-callback'

'''--------------------------------------------------------SPOTIFY-HELPER-FUNCTION--------------------------------------------------------'''

def validate_spotify_token(token):
    """Validate a Spotify token by making a test API call"""
    try:
        headers = {"Authorization": f"Bearer {token}"}
        response = requests.get("https://api.spotify.com/v1/me", headers=headers, timeout=10)
        if response.status_code == 200:
            user_info = response.json()
            print(f"Token validation successful for user: {user_info.get('display_name', 'Unknown')}")
            return True
        else:
            print(f"Token validation failed with status: {response.status_code}")
            return False
    except Exception as e:
        print(f"Token validation error: {e}")
        return False

def get_spotify_token(user_id):
    user = users.query.filter_by(username=user_id).first()
    if not user:
        print(f"User {user_id} not found in database")
        return None
    
    if not user.spotify_access_token:
        print(f"No access token for user {user_id}")
        return None

    # Check if token is expired (with 5 minute buffer)
    if user.spotify_token_expiry and user.spotify_token_expiry > datetime.datetime.now() + datetime.timedelta(minutes=5):
        print(f"Token still valid for user {user_id}")
        # Validate the token to ensure it's still working
        if validate_spotify_token(user.spotify_access_token):
            return user.spotify_access_token
        else:
            print(f"Token validation failed for user {user_id}, attempting refresh")

    # Token is expired or about to expire, use refresh token to get a new one
    if not user.spotify_refresh_token:
        print(f"No refresh token available for user {user_id}")
        return None

    try:
        print(f"Refreshing token for user {user_id}")
        token_url = "https://accounts.spotify.com/api/token"
        auth_string = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}"
        auth_bytes = auth_string.encode("utf-8")
        auth_base64 = str(base64.b64encode(auth_bytes), "utf-8")

        headers = {
            "Authorization": f"Basic {auth_base64}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {
            "grant_type": "refresh_token",
            "refresh_token": user.spotify_refresh_token
        }
        
        response = requests.post(token_url, headers=headers, data=data, timeout=10)
        response.raise_for_status()
        token_data = response.json()
        
        # Update user with new token
        user.spotify_access_token = token_data.get("access_token")
        user.spotify_token_expiry = datetime.datetime.now() + datetime.timedelta(seconds=token_data.get("expires_in", 3600))
        if token_data.get("refresh_token"):
            user.spotify_refresh_token = token_data.get("refresh_token")
        db.session.commit()
        
        print(f"Successfully refreshed token for user {user_id}")
        return user.spotify_access_token
    except requests.RequestException as e:
        print(f"Error refreshing Spotify token for user {user_id}: {e}")
        return None
    except Exception as e:
        print(f"Unexpected error refreshing token for user {user_id}: {e}")
        return None

'''--------------------------------------------------------HELPER-FUNCTION--------------------------------------------------------'''

def generate_room_key(length=5):
    characters = string.ascii_uppercase + string.digits
    return ''.join(random.choice(characters) for i in range(length))

'''--------------------------------------------------------APP-ROUTES--------------------------------------------------------'''


'''--------------------------------------------------------HOME-PAGE-ROUTE--------------------------------------------------------'''

@app.route('/', methods=["GET","POST"])
def entry():
    if "user" in session:
        return redirect(url_for("home"))
    else:
        return redirect(url_for("login"))
    
'''--------------------------------------------------------LOGIN-ROUTE--------------------------------------------------------'''

@app.route('/login', methods=["GET","POST"])
def login():
    if request.method == "POST":
        login_id = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        # Allow login by username or email
        user_obj = users.query.filter((users.username == login_id) | (users.email == login_id)).first()
        if user_obj and user_obj.password_hash == password:
            session["user"] = user_obj.username
            return redirect(url_for("home"))
        else:
            if user_obj and user_obj.password_hash != password:
                flash("Incorrect password")
            else:
                flash("User not found")
            return render_template("login.html")
    if "user" in session:
        return redirect(url_for("home"))
    return render_template("login.html")

'''--------------------------------------------------------REGISTER-ROUTE--------------------------------------------------------'''

@app.route('/register', methods=["GET","POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        # Basic presence and confirm
        if not username:
            flash("Username is required")
            return render_template("register.html")
        if not email:
            flash("Email is required")
            return render_template("register.html")
        if not password:
            flash("Password is required")
            return render_template("register.html")
        if password != confirm_password:
            flash("Passwords do not match")
            return render_template("register.html")

        # Username uniqueness
        if users.query.filter_by(username=username).first():
            flash("Username already taken")
            return render_template("register.html")
        if users.query.filter_by(email=email).first():
            flash("Email already registered")
            return render_template("register.html")

        # Password policy: > 8 chars, includes number and symbol
        if len(password) <= 8:
            flash("Password must be more than 8 characters")
            return render_template("register.html")
        if not re.search(r"\d", password):
            flash("Password must include at least one number")
            return render_template("register.html")
        if not re.search(r"[^A-Za-z0-9]", password):
            flash("Password must include at least one symbol")
            return render_template("register.html")

        new_user = users(username=username, email=email, password=password)
        db.session.add(new_user)
        db.session.commit()
        flash("Registration successful. Please log in.")
        return redirect(url_for("login"))

    return render_template("register.html")

'''--------------------------------------------------------MAIN-PAGE-ROUTE--------------------------------------------------------'''

@app.route('/home', methods=["GET","POST"])
def home():
    if "user" in session:
        user_obj = users.query.filter_by(username=session.get("user")).first()
        return render_template("home.html", user=user_obj)
    return redirect(url_for("login"))
    
'''--------------------------------------------------------SPOTIFY-LOGIN-ROUTE--------------------------------------------------------'''

@app.route('/spotify-login')
def spotify_login():
    if "user" not in session:
        flash("You must be logged in to connect to Spotify.")
        return redirect(url_for("login"))
    
    # Remember where to return after successful Spotify auth
    try:
        session['post_spotify_redirect'] = request.referrer or url_for('home')
    except Exception:
        session['post_spotify_redirect'] = url_for('home')
    
    # Define the scopes (permissions) your app needs
    SCOPES = 'user-read-private user-read-email streaming app-remote-control user-read-playback-state user-modify-playback-state user-top-read user-library-read'
    
    # Spotify's authorization URL
    auth_url = 'https://accounts.spotify.com/authorize?' + urllib.parse.urlencode({
        'response_type': 'code',
        'client_id': SPOTIFY_CLIENT_ID,
        'scope': SCOPES,
        'redirect_uri': SPOTIFY_REDIRECT_URI,
        'show_dialog': 'true' # Force re-authorization to accept new scopes
    })
    
    return redirect(auth_url)

'''--------------------------------------------------------SPOTIFY-CALLBACK-ROUTE--------------------------------------------------------'''

@app.route('/spotify-callback')
def spotify_callback():
    code = request.args.get('code')
    if not code:
        flash("Spotify authorization failed.")
        return redirect(url_for("home"))

    try:
        token_url = "https://accounts.spotify.com/api/token"
        auth_string = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}"
        auth_bytes = auth_string.encode("utf-8")
        auth_base64 = str(base64.b64encode(auth_bytes), "utf-8")

        headers = {
            "Authorization": f"Basic {auth_base64}",
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": SPOTIFY_REDIRECT_URI
        }
        
        response = requests.post(token_url, headers=headers, data=data, timeout=10)
        response.raise_for_status()
        token_data = response.json()
        
        # Save tokens to the user in the database
        user = users.query.filter_by(username=session['user']).first()
        if user:
            user.spotify_access_token = token_data.get("access_token")
            user.spotify_refresh_token = token_data.get("refresh_token")
            user.spotify_token_expiry = datetime.datetime.now() + datetime.timedelta(seconds=token_data.get("expires_in"))
            db.session.commit()
            flash("Spotify account linked successfully!", "success")
        else:
            flash("User not found after Spotify login.", "error")
            
    except requests.RequestException as e:
        print(f"Error during Spotify token exchange: {e}")
        flash("An error occurred during Spotify authentication. Please try again.", "error")
        
    # Redirect back to the page the user started from (e.g., room)
    next_url = session.pop('post_spotify_redirect', None)
    if not next_url:
        next_url = url_for("home")
    return redirect(next_url)

'''--------------------------------------------------------SPOTIFY-DISCONNECT-ROUTE--------------------------------------------------------'''

@app.route('/spotify-disconnect', methods=['POST'])
def spotify_disconnect():
    if "user" not in session:
        flash("You must be logged in to disconnect from Spotify.")
        return redirect(url_for('login'))
    
    user = users.query.filter_by(username=session['user']).first()
    if user:
        user.spotify_access_token = None
        user.spotify_refresh_token = None
        user.spotify_token_expiry = None
        db.session.commit()
        flash("Spotify account unlinked successfully.", "success")
    else:
        flash("User not found.", "error")
        
    return redirect(url_for('home'))

'''--------------------------------------------------------SPOTIFY-DEBUG-ROUTE--------------------------------------------------------'''

@app.route('/spotify-debug')
def spotify_debug():
    if "user" not in session:
        return jsonify({'error': 'Not logged in'}), 401
    
    user_id = session.get('user')
    user = users.query.filter_by(username=user_id).first()
    
    if not user:
        return jsonify({'error': 'User not found'}), 404
    
    debug_info = {
        'user_id': user_id,
        'has_access_token': bool(user.spotify_access_token),
        'has_refresh_token': bool(user.spotify_refresh_token),
        'token_expiry': user.spotify_token_expiry.isoformat() if user.spotify_token_expiry else None,
        'token_expired': user.spotify_token_expiry < datetime.datetime.now() if user.spotify_token_expiry else True
    }
    
    # Test token if available
    if user.spotify_access_token:
        token = get_spotify_token(user_id)
        if token:
            debug_info['token_valid'] = validate_spotify_token(token)
        else:
            debug_info['token_valid'] = False
    else:
        debug_info['token_valid'] = False
    
    return jsonify(debug_info)

'''--------------------------------------------------------CREATE-ROOM-ROUTE--------------------------------------------------------'''

@app.route('/create-room', methods=['POST'])
def create_room():
    try:
        if "user" not in session:
            flash('You must be logged in to create a room.', 'error')
            return redirect(url_for('home'))
            
        room_name = request.form.get("room_name")
        if not room_name:
            flash('Room name is required.', 'error')
            return redirect(url_for('home'))
        
        # Generate unique room key
        room_key = generate_room_key()
        while PrivateRooms.find_one({'room_key': room_key}):
            room_key = generate_room_key()
        
        # Create private room
        new_room = {
            'name': room_name,
            'room_key': room_key,
            'creator': session['user'],
            'listeners': 0,
            'created_at': datetime.datetime.now()
        }
        
        PrivateRooms.insert_one(new_room)
        flash(f'Successfully created private room: {room_name} (Code: {room_key})', 'success')
        return redirect(url_for('home'))

    except Exception as e:
        print(f"Error creating private room: {e}")
        flash('An error occurred while creating the private room. Please try again.', 'error')
        return redirect(url_for('home'))

'''--------------------------------------------------------JOIN-ROOM-ROUTE--------------------------------------------------------'''

@app.route('/join-room', methods=["POST"])
def join_room_route():
    if "user" not in session:
        return jsonify({'error': 'You must be logged in to join a room.', 'redirect_url': url_for("login")}), 401

    data = request.get_json()
    room_key = data.get("room_key", "").strip().upper()

    if not room_key:
        return jsonify({'error': 'Room code is required.'}), 400
        
    room = PublicRooms.find_one({'room_key': room_key}) or PrivateRooms.find_one({'room_key': room_key})

    if room:
        return jsonify({'redirect_url': url_for("room_page", room_key=room_key)})
    else:
        return jsonify({'error': 'Room not found.'}), 404

'''--------------------------------------------------------ROOM-ROUTES--------------------------------------------------------'''

@app.route('/room/<room_key>', methods=["GET", "POST"])
def room_page(room_key):
    if "user" not in session:
        flash("You must be logged in to view a room.")
        return redirect(url_for("login"))
    
    room_data = PublicRooms.find_one({'room_key': room_key}) or PrivateRooms.find_one({'room_key': room_key})

    if not room_data:
        flash("Room not found.")
        return redirect(url_for("home"))
    
    user = users.query.filter_by(username=session['user']).first()
    
    # Get a fresh Spotify access token
    spotify_token = get_spotify_token(user.username) if user else None

    if not spotify_token:
        flash('Please link your Spotify account to use the music player.', 'warning')
    
    return render_template("room.html", room=room_data, user=user, spotify_access_token=spotify_token)

'''--------------------------------------------------------CREATE-PUBLIC-ROOM-ROUTE--------------------------------------------------------'''

@app.route('/create-public-room', methods=['POST'])
def create_public_room():
    try:
        if "user" not in session:
            flash('You must be logged in to create a room.', 'error')
            return redirect(url_for('home'))
            
        room_name = request.form.get("room_name")
        if not room_name:
            flash('Room name is required.', 'error')
            return redirect(url_for('home'))
        
        # Generate unique room key
        room_key = generate_room_key()
        while PublicRooms.find_one({'room_key': room_key}):
            room_key = generate_room_key()
        
        # Create public room
        new_room = {
            'name': room_name,
            'room_key': room_key,
            'creator': session['user'],
            'listeners': 0,
            'created_at': datetime.datetime.now()
        }
        
        PublicRooms.insert_one(new_room)
        flash(f'Successfully created public room: {room_name} (Code: {room_key})', 'success')
        return redirect(url_for('home'))

    except Exception as e:
        print(f"Error creating public room: {e}")
        flash('An error occurred while creating the room. Please try again.', 'error')
        return redirect(url_for('home'))

'''--------------------------------------------------------API-END-POINT-ROUTE--------------------------------------------------------'''

@app.route('/api/public-rooms', methods=['GET'])
def public_rooms_api():
    try:
        rooms = list(PublicRooms.find({}))

        for room in rooms:
            if '_id' in room:
                room['_id'] = str(room['_id'])

        return jsonify(rooms)
    
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
'''--------------------------------------------------------SEARCH-SONG-ROUTE--------------------------------------------------------'''

@app.route('/api/search', methods=['GET'])
def search_songs():
    search_term = request.args.get('q', '').strip()
    user_id = session.get('user')
    
    if not user_id:
        print("Search request from unauthenticated user")
        return jsonify({'error': 'User not authenticated'}), 401

    if not search_term:
        print(f"Empty search term from user {user_id}")
        return jsonify({'error': 'Search term is required'}), 400

    print(f"Search request from user {user_id} for: {search_term}")
    token = get_spotify_token(user_id)
    if not token:
        print(f"Failed to get valid token for user {user_id}")
        return jsonify({'error': 'Failed to authenticate with Spotify. Please re-link your account.'}), 500

    try:
        search_url = "https://api.spotify.com/v1/search"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        params = {
            "q": search_term,
            "type": "track",
            "limit": 10
        }
        
        print(f"Making Spotify API request to: {search_url}")
        response = requests.get(search_url, headers=headers, params=params, timeout=15)
        
        if response.status_code == 401:
            print(f"Spotify API returned 401 Unauthorized for user {user_id}")
            return jsonify({'error': 'Spotify authentication expired. Please re-link your account.'}), 401
        elif response.status_code == 403:
            print(f"Spotify API returned 403 Forbidden for user {user_id}")
            return jsonify({'error': 'Spotify access denied. Please ensure your account has Spotify Premium and re-link your account.'}), 403
        elif response.status_code == 429:
            print(f"Spotify API rate limit exceeded for user {user_id}")
            return jsonify({'error': 'Rate limit exceeded. Please try again later.'}), 429
        
        response.raise_for_status()
        spotify_data = response.json()

        songs = []
        tracks = spotify_data.get('tracks', {}).get('items', [])
        print(f"Found {len(tracks)} tracks for search: {search_term}")
        
        for track in tracks:
            artist_name = track['artists'][0]['name'] if track['artists'] else 'Unknown Artist'
            # Use the first available image, fallback to None
            artwork_url = None
            if track['album']['images']:
                # Prefer medium size (index 1), fallback to first available
                artwork_url = track['album']['images'][1]['url'] if len(track['album']['images']) > 1 else track['album']['images'][0]['url']
            
            songs.append({
                'id': track['id'],
                'uri': track['uri'],
                'title': track['name'],
                'artist': artist_name,
                'album': track['album']['name'],
                'artwork': artwork_url,
                'duration': track['duration_ms'] / 1000, 
                'preview': track['preview_url']
            })
        
        print(f"Returning {len(songs)} songs to user {user_id}")
        return jsonify(songs)
    
    except requests.RequestException as e:
        print(f"Spotify API search error for user {user_id}: {e}")
        return jsonify({'error': f'Failed to fetch music data from Spotify: {str(e)}'}), 500
    except Exception as e:
        print(f"Unexpected error in search for user {user_id}: {e}")
        return jsonify({'error': 'An unexpected error occurred while searching'}), 500

'''--------------------------------------------------------LOGOUT-ROUTE--------------------------------------------------------'''

@app.route('/logout', methods=["POST"])
def logout():
    session.pop("user", None)
    get_flashed_messages() 
    return redirect(url_for("login"))

'''--------------------------------------------------------RUN-APP--------------------------------------------------------'''
        
if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    socketio.run(app, port='4444', host='0.0.0.0', debug=False)