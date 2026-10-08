from flask import Flask, jsonify

app = Flask(__name__)
UPLOAD_DIR = "/srv/uploads"


@app.get("/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
