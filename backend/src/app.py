import sys
import os

# Add src to path to ensure imports work
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
import json

# Email Imports
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage

# Modules
import analysis_service
import side_view_service  
import gemini_service
import scoring_utils

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'temp_uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

@app.route('/', methods=['GET'])
def health_check():
    return "Rebar Analysis API is Running!", 200

# --- TOP VIEW ---
@app.route('/analyze', methods=['POST', 'OPTIONS'])
def analyze_top():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_img = request.files['real_image']
        design_img = request.files.get('design_image')
        
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        real_path = os.path.join(UPLOAD_FOLDER, "temp_real.jpg")
        real_img.save(real_path)
        
        img_array = cv2.imread(real_path)
        if img_array is None:
             return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # 1. CV Analysis
        annotated_img, actual_data, has_scale = analysis_service.process_image(
            img_array, rod_points, ref_points, ref_length
        )

        # 2. Gemini Analysis
        design_data = {"count": 0, "radius_mm": 0, "spacings_mm":[]}
        revit_data = {"reset": True, "rod": None} # Default Revit Data
        
        # Determine Design Data
        if design_img:
            design_path = os.path.join(UPLOAD_FOLDER, "temp_design.jpg")
            design_img.save(design_path)
            design_data = gemini_service.extract_design_data(design_path)
        else:
            design_path = None

        # 3. Gemini Defect Detection for Revit
        rod_count = len(rod_points)
        revit_data = gemini_service.detect_defects_for_revit(real_path, design_path, rod_count)

        # 4. Scoring
        score, table = scoring_utils.calculate_similarity_and_table(
            design_data, actual_data, has_scale
        )

        _, buffer = cv2.imencode('.jpg', annotated_img)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        return jsonify({
            "status": "success",
            "score": score,
            "comparison_table": table,
            "annotated_image": f"data:image/jpeg;base64,{img_base64}",
            "revit_data": revit_data,
            "raw_design_data": design_data,
            "raw_actual_data": actual_data
        })

    except Exception as e:
        print(f"Top Error: {e}")
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
        img_b64 = data.get('image', '').split(',')[-1] # Remove the "data:image/jpeg;base64," prefix

        SENDER_EMAIL = "pradnya.patil.sitpune@gmail.com" 
        SENDER_PASS = "dzbk iiiv vxhn adip"

        msg = MIMEMultipart('related')
        msg['Subject'] = f"Rebar Inspection Alert: Column {column_number} - Score {score}%"
        msg['From'] = SENDER_EMAIL
        msg['To'] = authority_email

        # Build HTML Email Body with the compliance table
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
            # Color code the status
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

        # Embed Image
        if img_b64:
            img_data = base64.b64decode(img_b64)
            img_attachment = MIMEImage(img_data)
            img_attachment.add_header('Content-ID', '<annotated_img>')
            msg.attach(img_attachment)

        # Send Email
        with smtplib.SMTP('smtp.gmail.com', 587) as server:
            server.starttls()
            server.login(SENDER_EMAIL, SENDER_PASS)
            server.send_message(msg)

        return jsonify({"status": "success", "message": "Email sent successfully"}), 200
    except Exception as e:
        print(f"Email Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# --- SIDE VIEW ---
@app.route('/analyze/side', methods=['POST', 'OPTIONS'])
def analyze_side():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_img = request.files['real_image']
        design_img = request.files.get('design_image') 
        
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        real_path = os.path.join(UPLOAD_FOLDER, "temp_side_real.jpg")
        real_img.save(real_path)
        
        annotated_img, results, has_scale = side_view_service.process_side_view(
            real_path, rod_points, ref_points, ref_length
        )

        design_data = {"spacing_mm": 0}
        if design_img:
            design_path = os.path.join(UPLOAD_FOLDER, "temp_side_design.jpg")
            design_img.save(design_path)
            design_data = gemini_service.extract_side_design_data(design_path)

        score, table = scoring_utils.calculate_side_view_score(
            design_data, results, has_scale
        )

        _, buffer = cv2.imencode('.jpg', annotated_img)
        img_base64 = base64.b64encode(buffer).decode('utf-8')

        return jsonify({
            "status": "success",
            "score": score,
            "comparison_table": table,
            "annotated_image": f"data:image/jpeg;base64,{img_base64}",
            "raw_design_data": design_data,
            "raw_actual_data": results
        })

    except Exception as e:
        print(f"Side View Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)