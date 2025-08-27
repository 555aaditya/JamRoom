from flask import Flask, request, render_template, session, redirect, url_for, flash, Blueprint
from flask_sqlalchemy import SQLAlchemy
from dotenv import load_dotenv
import os
import re

load_dotenv()

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///users.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.secret_key = os.getenv('SECRET_KEY')

db = SQLAlchemy(app)

class users(db.Model):
    _id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(20), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)

    def __init__(self, username, email, password):
        self.username = username
        self.email = email
        self.password_hash = password

# Home Page
@app.route('/', methods=["GET","POST"])
def entry():
    if "user" in session:
        return render_template("home.html", user=session.get("user"))
    else:
        return redirect(url_for("login"))

@app.route('/login', methods=["GET","POST"])
def login():
    if request.method == "POST":
        login_id = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        # Allow login by username or email
        user_obj = users.query.filter((users.username == login_id) | (users.email == login_id)).first()
        if user_obj and user_obj.password_hash == password:
            session["user"] = user_obj.username
            return render_template("home.html", user=user_obj.username)
        else:
            if user_obj and user_obj.password_hash != password:
                flash("Incorrect password")
            else:
                flash("User not found")
            return render_template("login.html")
    if "user" in session:
        return render_template("home.html", user=session.get("user"))
    return render_template("login.html")

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

@app.route('/logout', methods=["POST"]) 
def logout():
    session.pop("user", None)
    return redirect(url_for("login"))
        
if __name__ == '__main__':
    db.create_all()
    app.run(port='4444', host='0.0.0.0', debug=False)