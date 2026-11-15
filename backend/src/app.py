import sys
import os
import html
import cv2
import numpy as np
import base64
import json
import threading
import requests
from dotenv import load_dotenv

# Ensure local imports and .env loading work regardless of working directory
SRC_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SRC_DIR)
sys.path.append(SRC_DIR)
load_dotenv(os.path.join(BACKEND_DIR, '.env'))

from flask import Flask, request, jsonify
from flask_cors import CORS

# Modules
import analysis_service
import side_view_service

app = Flask(__name__)
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:4200").rstrip("/")
allowed_origins = list(dict.fromkeys(["http://localhost:4200", FRONTEND_URL]))

CORS(app, resources={r"/*": {
    "origins": allowed_origins,
    "methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["Content-Type"]
}})


def scale_normalized_points(norm_points, width, height):
    """Scale [0..1] normalized coordinates safely into pixel indices."""
    scaled = []
    for p in norm_points:
        px = min(max(int(round(p[0] * width)), 0), width - 1)
        py = min(max(int(round(p[1] * height)), 0), height - 1)
        scaled.append([px, py])
    return scaled


@app.route('/', methods=['GET'])
def health_check():
    return "Rebar Analysis API Awake & Warmed Up!", 200


# --- TOP VIEW CV ANALYSIS ---
@app.route('/analyze-cv', methods=['POST', 'OPTIONS'])
def analyze_top_cv():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200
    try:
        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_bytes = request.files['real_image'].read()
        norm_rod_points = json.loads(request.form.get('rod_points', '[]'))
        norm_ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length') or 0)

        design_data = json.loads(request.form.get('design_data', '{}'))
        statuses_str = request.form.get('statuses')
        statuses = json.loads(statuses_str) if statuses_str else None

        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
            return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # Scale normalized coordinates to the actual received compressed image dimension
        h, w = img_array.shape[:2]
        rod_points = scale_normalized_points(norm_rod_points, w, h)
        ref_points = scale_normalized_points(norm_ref_points, w, h)

        # Run Heavy Matrix Math calculations with Calibration Layer and Dynamic Coloring
        annotated_img, actual_data, has_scale = analysis_service.process_image(
            img_array, rod_points, ref_points, ref_length, design_data, statuses
        )

        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode('.jpg', annotated_img, encode_param)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        return jsonify({
            "status": "success",
            "annotated_image": f"data:image/jpeg;base64,{img_base64}",
            "actual_data": actual_data,
            "has_scale": has_scale
        })

    except Exception as e:
        print(f"Top View CV Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# --- SIDE VIEW CV ANALYSIS ---
@app.route('/analyze-cv/side', methods=['POST', 'OPTIONS'])
def analyze_side_cv():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200
    try:
        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_bytes = request.files['real_image'].read()
        norm_rod_points = json.loads(request.form.get('rod_points', '[]'))
        norm_ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length') or 0)

        design_data = json.loads(request.form.get('design_data', '{}'))
        statuses_str = request.form.get('statuses')
        statuses = json.loads(statuses_str) if statuses_str else None

        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
            return jsonify({"status": "error", "message": "Could not decode image"}), 400

        h, w = img_array.shape[:2]
        rod_points = scale_normalized_points(norm_rod_points, w, h)
        ref_points = scale_normalized_points(norm_ref_points, w, h)

        annotated_img, actual_data, has_scale = side_view_service.process_side_view(
            img_array, rod_points, ref_points, ref_length, design_data, statuses
        )

        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode('.jpg', annotated_img, encode_param)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        return jsonify({
            "status": "success",
            "annotated_image": f"data:image/jpeg;base64,{img_base64}",
            "actual_data": actual_data,
            "has_scale": has_scale
        })

    except Exception as e:
        print(f"Side View CV Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


# --- EMAIL NOTIFICATION ENDPOINT ---
@app.route('/send-email-report', methods=['POST', 'OPTIONS'])
def send_email_report():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({"status": "error", "message": "Invalid JSON payload"}), 400

        column_number = str(data.get('column_number') or 'Unknown').strip()
        authority_email = str(data.get('email') or '').strip()
        score = data.get('score')
        quality_label = str(data.get('label') or 'Defective')
        table = data.get('table') or []
        img_b64 = (data.get('image') or '').split(',')[-1]

        if not authority_email:
            return jsonify({"status": "error", "message": "Recipient email is required"}), 400

        SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
        BREVO_API_KEY = os.environ.get("BREVO_API_KEY")

        if not SENDER_EMAIL or not BREVO_API_KEY:
            return jsonify({"status": "error", "message": "Server API credentials not configured"}), 500

        safe_col = html.escape(column_number)
        safe_label = html.escape(quality_label)
        safe_score = html.escape(str(score))
        subject = f"Rebar Inspection Alert: Column {column_number} - {quality_label} ({score}%)"

        # Build the HTML
        html_body = f"""
        <html>
          <body>
            <h2 style="color: #d32f2f; font-family: Arial, sans-serif;">Rebar Quality Deviation Alert</h2>
            <p style="font-family: Arial, sans-serif;">A recent site inspection for <strong style="color: #d32f2f;">Column {safe_col}</strong> has yielded a similarity score of <strong style="color: #d32f2f;">{safe_score}% ({safe_label})</strong>, which falls below the acceptable 80% threshold.</p>
            <h3 style="font-family: Arial, sans-serif;">Compliance Table</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-family: Arial, sans-serif; width: 100%; max-width: 800px;">
              <tr style="background-color: #f2f2f2; text-align: left;">
                <th>Parameter</th><th>Design Spec</th><th>Site Actual</th><th>Status</th>
              </tr>
        """
        for row in table:
            status = str(row.get('status', 'NA'))
            if status == "Not Acceptable":
                status_color = "#d32f2f"
            elif status == "Minor Mismatch":
                status_color = "#f57c00"
            elif status == "Acceptable":
                status_color = "#388e3c"
            else:
                status_color = "#64748b"

            html_body += f"""<tr>
                <td>{html.escape(str(row.get('parameter', '')))}</td>
                <td>{html.escape(str(row.get('design', '')))}</td>
                <td>{html.escape(str(row.get('actual', '')))}</td>
                <td style="color: {status_color}; font-weight: bold;">{html.escape(status)}</td>
            </tr>"""

        html_body += """
            </table>
            <br>
            <p style="font-family: Arial, sans-serif;">Please find the annotated site photograph attached to this email.</p>
          </body>
        </html>
        """

        # Dispatch asynchronously so the HTTP response returns immediately
        def send_brevo_email(api_key, sender_email, to_email, subj, body_html, b64_img):
            url = "https://api.brevo.com/v3/smtp/email"
            headers = {
                "accept": "application/json",
                "api-key": api_key,
                "content-type": "application/json"
            }

            payload = {
                "sender": {"name": "RebarAnalysis Alert", "email": sender_email},
                "to": [{"email": to_email}],
                "subject": subj,
                "htmlContent": body_html,
            }

            if b64_img:
                payload["attachment"] = [{"content": b64_img, "name": "annotated_site.jpg"}]

            try:
                response = requests.post(url, json=payload, headers=headers, timeout=15)
                print(f"Brevo API Response: {response.status_code} - {response.text}")
            except Exception as e:
                print(f"Async Email Dispatch Error: {e}")

        threading.Thread(
            target=send_brevo_email,
            args=(BREVO_API_KEY, SENDER_EMAIL, authority_email, subject, html_body, img_b64),
            daemon=True
        ).start()

        return jsonify({"status": "success", "message": "Email dispatch initiated successfully"}), 200
    except Exception as e:
        print(f"Email Controller Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, port=5000)