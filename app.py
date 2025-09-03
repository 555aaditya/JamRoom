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

# .env file
load_dotenv()

# flask app initialization
app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')

# SocketIO Initialization
socketio = SocketIO(app)

'''--------------------------------------------------------SOCKET-IO-EVENTS--------------------------------------------------------'''

@socketio.on('connect')
def handle_connect():
    print("Client connected")

@socketio.on('disconnect')
def handle_disconnect():
    print("Client disconnected")

@socketio.on('join')
def on_join(data):
    username = data['username']
    room_key = data['room_key']
    
    room_data = PublicRooms.find_one({'room_key': room_key})
    if room_data:
        PublicRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': 1}})
    else:
        room_data = PrivateRooms.find_one({'room_key': room_key})
        if room_data:
            PrivateRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': 1}})
    
    updated_room_data = PublicRooms.find_one({'room_key': room_key}) or PrivateRooms.find_one({'room_key': room_key})
    updated_listeners = updated_room_data['listeners']

    join_room(room_key)
    
    emit('room_message', {'msg': f'{username} has entered the room. ({updated_listeners} listeners)'}, room=room_key)

@socketio.on('leave')
def on_leave(data):
    username = data['username']
    room_key = data['room_key']

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
    return { 'status': 'ok' }
        
@socketio.on('send_message')
def handle_message(data):
    room_key = data['room_key']
    message = data['msg']
    username = data['username']
    
    emit('new_message', {'username': username, 'msg': message}, room=room_key)

@socketio.on('song_play')
def handle_song_play(data):
    room_key = data['room_key']
    song = data['song']
    timestamp = data.get('timestamp', 0)
    
    # Broadcast to all users in the room except the sender
    emit('song_play', {
        'song': song,
        'timestamp': timestamp
    }, room=room_key, include_self=False)

@socketio.on('song_pause')
def handle_song_pause(data):
    room_key = data['room_key']
    timestamp = data.get('timestamp', 0)
    
    # Broadcast to all users in the room except the sender
    emit('song_pause', {
        'timestamp': timestamp
    }, room=room_key, include_self=False)

@socketio.on('song_ended')
def handle_song_ended(data):
    room_key = data['room_key']
    timestamp = data.get('timestamp', 0)
    
    # Broadcast to all users in the room except the sender
    emit('song_ended', {
        'timestamp': timestamp
    }, room=room_key, include_self=False)

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

def get_spotify_token(user_id):
    user = users.query.filter_by(username=user_id).first()
    if not user or not user.spotify_access_token:
        return None

    # Check if token is expired
    if user.spotify_token_expiry and user.spotify_token_expiry > datetime.datetime.now():
        return user.spotify_access_token

    # Token is expired, use refresh token to get a new one
    if not user.spotify_refresh_token:
        print("No refresh token available.")
        return None

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
            "grant_type": "refresh_token",
            "refresh_token": user.spotify_refresh_token
        }
        
        response = requests.post(token_url, headers=headers, data=data, timeout=10)
        response.raise_for_status()
        token_data = response.json()
        
        # Update user with new token
        user.spotify_access_token = token_data.get("access_token")
        user.spotify_token_expiry = datetime.datetime.now() + datetime.timedelta(seconds=token_data.get("expires_in"))
        if token_data.get("refresh_token"):
            user.spotify_refresh_token = token_data.get("refresh_token")
        db.session.commit()
        
        return user.spotify_access_token
    except requests.RequestException as e:
        print(f"Error refreshing Spotify token: {e}")
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
    scope = 'user-read-private user-read-email streaming app-remote-control user-read-playback-state user-modify-playback-state'
    
    # Spotify's authorization URL
    auth_url = 'https://accounts.spotify.com/authorize?' + urllib.parse.urlencode({
        'response_type': 'code',
        'client_id': SPOTIFY_CLIENT_ID,
        'scope': scope,
        'redirect_uri': SPOTIFY_REDIRECT_URI,
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
    if not user or not user.spotify_access_token:
        # User needs to link Spotify account
        flash('Please link your Spotify account to use the music player.', 'warning')
    
    return render_template("room.html", room=room_data, user=user)

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
        return jsonify({'error': 'User not authenticated'}), 401

    token = get_spotify_token(user_id)
    if not token:
        return jsonify({'error': 'Failed to authenticate with Spotify. Please re-link your account.'}), 500

    try:
        search_url = "https://api.spotify.com/v1/search"
        headers = {
            "Authorization": f"Bearer {token}"
        }
        params = {
            "q": search_term,
            "type": "track",
            "limit": 10
        }
        
        response = requests.get(search_url, headers=headers, params=params, timeout=10)
        response.raise_for_status()
        spotify_data = response.json()

        songs = []
        for track in spotify_data.get('tracks', {}).get('items', []):
            artist_name = track['artists'][0]['name'] if track['artists'] else 'Unknown Artist'
            artwork_url = track['album']['images'][1]['url'] if track['album']['images'] else None
            
            songs.append({
                'id': track['id'],
                'uri': track['uri'], # New field for the SDK
                'title': track['name'],
                'artist': artist_name,
                'album': track['album']['name'],
                'artwork': artwork_url,
                'duration': track['duration_ms'] / 1000, 
                'preview': track['preview_url']
            })
        
        return jsonify(songs)
    
    except requests.RequestException as e:
        print(f"Spotify API search error: {e}")
        return jsonify({'error': 'Failed to fetch music data from Spotify'}), 500

'''--------------------------------------------------------LOGOUT-ROUTE--------------------------------------------------------'''

@app.route('/logout', methods=["POST"])
def logout():
    session.pop("user", None)
    get_flashed_messages() 
    return redirect(url_for("login"))

'''--------------------------------------------------------RUN-APP--------------------------------------------------------'''
        
if __name__ == '__main__':
    db.create_all()
    socketio.run(app, port='4444', host='0.0.0.0', debug=False)