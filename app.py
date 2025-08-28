'''--------------------------------------------------------IMPORTS--------------------------------------------------------'''

from flask import Flask, request, render_template, session, redirect, url_for, flash, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit, send
from pymongo import MongoClient
from flask_sqlalchemy import SQLAlchemy
from dotenv import load_dotenv
import random
import string
import os
import re

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
    
    PublicRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': 1}})

    join_room(room_key)
    
    room_data = PublicRooms.find_one({'room_key': room_key})
    updated_listeners = room_data['listeners']

    emit('room_message', {'msg': f'{username} has entered the room. ({updated_listeners} listeners)'}, room=room_key)

# This code should already be in your app.py file

@socketio.on('leave')
def on_leave(data):
    username = data['username']
    room_key = data['room_key']

    # Decrement the listener count for the room in MongoDB
    PublicRooms.update_one({'room_key': room_key}, {'$inc': {'listeners': -1}})

    leave_room(room_key)

    # Get the updated listener count
    room_data = PublicRooms.find_one({'room_key': room_key})
    updated_listeners = room_data['listeners']

    # Emit a message to all clients in the room with the updated listener count
    emit('room_message', {'msg': f'{username} has left the room. ({updated_listeners} listeners)'}, room=room_key)
    
@socketio.on('send_message')
def handle_message(data):
    room_key = data['room_key']
    message = data['msg']
    username = data['username']
    
    emit('new_message', {'username': username, 'msg': message}, room=room_key)

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
        return render_template("home.html", user=session.get("user"))
    
'''--------------------------------------------------------CREATE-ROOM-ROUTE--------------------------------------------------------'''

@app.route('/create-room', methods=["POST"])
def create_room():
    if "user" not in session:
        flash("You must be logged in to create a room.")
        return redirect(url_for("login"))

    room_name = request.form.get("room_name", "").strip()
    if not room_name:
        flash("Room name is required.")
        return redirect(url_for("home"))

    room_key = generate_room_key()
    while PublicRooms.find_one({'room_key': room_key}):
        room_key = generate_room_key()

    new_room = {
        'name': room_name,
        'room_key': room_key,
        'listeners': 0,
        'creator': session.get("user")
    }
    
    PublicRooms.insert_one(new_room)
    
    flash(f"Room '{room_name}' created successfully with code: {room_key}")
    return redirect(url_for("home"))

'''--------------------------------------------------------JOIN-ROOM-ROUTE--------------------------------------------------------'''

@app.route('/join-room', methods=["POST"])
def join_room_route():
    if "user" not in session:
        flash("You must be logged in to join a room.")
        return redirect(url_for("login"))

    room_key = request.form.get("room_key", "").strip().upper()
    if not room_key:
        flash("Room code is required.")
        return redirect(url_for("home"))
        
    public_room = PublicRooms.find_one({'room_key': room_key})

    if public_room:
        return redirect(url_for("room_page", room_key=room_key))
    else:
        flash("Room not found.")
        return redirect(url_for("home"))
    
'''--------------------------------------------------------ROOM-ROUTES--------------------------------------------------------'''

@app.route('/room/<room_key>', methods=["GET", "POST"])
def room_page(room_key):
    if "user" not in session:
        flash("You must be logged in to view a room.")
        return redirect(url_for("login"))
    
    room_data = PublicRooms.find_one({'room_key': room_key})

    if not room_data:
        flash("Room not found.")
        return redirect(url_for("home"))

    return render_template("room.html", room=room_data)

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

'''--------------------------------------------------------LOGOUT-ROUTE--------------------------------------------------------'''

@app.route('/logout', methods=["POST"]) 
def logout():
    session.pop("user", None)
    return redirect(url_for("login"))
        
if __name__ == '__main__':
    db.create_all()
    socketio.run(app, port='4444', host='0.0.0.0', debug=False)