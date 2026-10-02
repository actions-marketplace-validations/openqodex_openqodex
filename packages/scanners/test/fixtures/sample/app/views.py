import subprocess
import sqlite3


def run(cmd):
    return subprocess.call(cmd, shell=True)


def find_user(conn: sqlite3.Connection, name):
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE name = '%s'" % name)
    return cur.fetchall()


def load(data):
    return eval(data)
