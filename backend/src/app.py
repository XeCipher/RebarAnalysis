import sys
import os

# Add src to path to ensure imports work
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify
from flask_cors import CORS
import base64
import json
import concurrent.futures

# Email Imports
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage

# Modules (Only heavy pure-Python services left!)
import analysis_service
import side_view_service  

app = Flask(__name__)
CORS(app, resources={r"/*": {
    "origins": ["http://localhost:4200", "https://rebaranalysis.vercel.app"],
    "methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["Content-Type"]
}})

@app.route('/', methods=['GET'])
def health_check():
    # Fixes Render's 50s spin up delay since frontend automatically hits this on land!
    return "Rebar Analysis API Awake & Warmed Up!", 200

# --- REFINE POINTS (FORMERLY AUTO-DETECT) ---
# Gemini points are now calculated in frontend to save bandwidth. This just applies math.
@app.route('/refine-points', methods=['POST', 'OPTIONS'])
def refine_points():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        import cv2
        import numpy as np

        if 'image' not in request.files:
            return jsonify({"status": "error", "message": "No image provided"}), 400
            
        file_bytes = request.files['image'].read()
        view_mode = request.form.get('view_mode', 'top')
        gemini_normalized_points = json.loads(request.form.get('gemini_points', '[]'))
        
        # Decode high-res image
        img_array = cv2.imdecode(np.frombuffer(file_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
            return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # OpenCV: Refine to exact pixel centers
        points = []
        if gemini_normalized_points:
            if view_mode == 'top':
                points = analysis_service.refine_gemini_points(img_array, gemini_normalized_points)
            else:
                points = side_view_service.refine_side_gemini_points(img_array, gemini_normalized_points)
                
        return jsonify({"status": "success", "points": points})
        
    except Exception as e:
        print(f"Refinement Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# --- TOP VIEW CV ANALYSIS ---
# Massive Performance increase - LLM offloaded entirely.
@app.route('/analyze-cv', methods=['POST', 'OPTIONS'])
def analyze_top_cv():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        import cv2
        import numpy as np

        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_bytes = request.files['real_image'].read()
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
             return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # Run Heavy Matrix Math calculations
        annotated_img, actual_data, has_scale = analysis_service.process_image(
            img_array, rod_points, ref_points, ref_length
        )

        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode('.jpg', annotated_img, encode_param)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        # Frontend will combine this mathematically derived data with the AI data!
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
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        import cv2
        import numpy as np

        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_bytes = request.files['real_image'].read()
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
             return jsonify({"status": "error", "message": "Could not decode image"}), 400

        annotated_img, actual_data, has_scale = side_view_service.process_side_view(
            img_array, rod_points, ref_points, ref_length
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
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        data = request.json
        column_number = data.get('column_number', 'Unknown')
        authority_email = data.get('email')
        score = data.get('score')
        table = data.get('table', [])
        img_b64 = data.get('image', '').split(',')[-1] 

        SENDER_EMAIL = os.environ.get("SENDER_EMAIL")
        SENDER_PASS = os.environ.get("SENDER_PASS")

        if not SENDER_EMAIL or not SENDER_PASS:
            return jsonify({"status": "error", "message": "Server email credentials not configured"}), 500

        msg = MIMEMultipart('related')
        msg['Subject'] = f"Rebar Inspection Alert: Column {column_number} - Score {score}%"
        msg['From'] = SENDER_EMAIL
        msg['To'] = authority_email

        html_body = f"""
        <html>
          <body>
            <h2 style="color: #d32f2f; font-family: Arial, sans-serif;">Rebar Inspection Failed</h2>
            <p style="font-family: Arial, sans-serif;">A recent site inspection for <strong style="color: #d32f2f;">Column {column_number}</strong> has yielded a similarity score of <strong style="color: #d32f2f;">{score}%</strong>.</p>
            <h3 style="font-family: Arial, sans-serif;">Compliance Table</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; font-family: Arial, sans-serif; width: 100%; max-width: 800px;">
              <tr style="background-color: #f2f2f2; text-align: left;">
                <th>Parameter</th><th>Design Spec</th><th>Site Actual</th><th>Status</th>
              </tr>
        """
        for row in table:
            status_color = "#d32f2f" if row['status'] == "Not Acceptable" else "#f57c00" if row['status'] == "Minor Mismatch" else "#388e3c"
            html_body += f"""<tr>
                <td>{row['parameter']}</td>
                <td>{row['design']}</td>
                <td>{row['actual']}</td>
                <td style="color: {status_color}; font-weight: bold;">{row['status']}</td>
            </tr>"""
        
        html_body += """
            </table>
            <br>
            <p style="font-family: Arial, sans-serif;">Please find the annotated site photograph attached below.</p>
            <img src="cid:annotated_img" alt="Annotated Site" style="max-width: 100%; border: 1px solid #ccc;"/>
          </body>
        </html>
        """
        
        msg_alt = MIMEMultipart('alternative')
        msg.attach(msg_alt)
        msg_alt.attach(MIMEText("Please view this email in an HTML compatible client.", 'plain'))
        msg_alt.attach(MIMEText(html_body, 'html'))

        if img_b64:
            img_data = base64.b64decode(img_b64)
            img_attachment = MIMEImage(img_data)
            img_attachment.add_header('Content-ID', '<annotated_img>')
            msg.attach(img_attachment)

        with smtplib.SMTP('smtp.gmail.com', 587) as server:
            server.starttls()
            server.login(SENDER_EMAIL, SENDER_PASS)
            server.send_message(msg)

        return jsonify({"status": "success", "message": "Email sent successfully"}), 200
    except Exception as e:
        print(f"Email Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)