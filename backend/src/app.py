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

# Modules
import analysis_service
import side_view_service  
import gemini_service
import scoring_utils

app = Flask(__name__)
CORS(app, resources={r"/*": {
    "origins": [
        "http://localhost:4200",                 # Local Angular dev server
        "https://rebaranalysis.vercel.app"       # Production Vercel app
    ],
    "methods": ["GET", "POST", "OPTIONS"],
    "allow_headers": ["Content-Type"]
}})

@app.route('/', methods=['GET'])
def health_check():
    return "Rebar Analysis API is Running!", 200

# --- TOP VIEW ---
@app.route('/analyze', methods=['POST', 'OPTIONS'])
def analyze_top():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        # Lazy load heavy dependencies
        import cv2
        import numpy as np

        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_img = request.files['real_image']
        design_img = request.files.get('design_image')
        
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        # Zero Disk I/O: Read directly into memory
        real_bytes = real_img.read()
        design_bytes = design_img.read() if design_img else None
        
        # Decode the byte stream into an OpenCV array
        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
             return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # Parallelize heavy workloads using ThreadPoolExecutor
        with concurrent.futures.ThreadPoolExecutor() as executor:
            # 1. CV Analysis Task
            future_cv = executor.submit(
                analysis_service.process_image,
                img_array, rod_points, ref_points, ref_length
            )

            # 2. Gemini Design Extraction Task
            if design_bytes:
                future_design = executor.submit(
                    gemini_service.extract_design_data,
                    design_bytes
                )
            else:
                future_design = None

            # 3. Gemini Defect Detection Task
            rod_count = len(rod_points)
            future_defect = executor.submit(
                gemini_service.detect_defects_for_revit,
                real_bytes, design_bytes, rod_count
            )

            # Wait for and collect the parallel results
            annotated_img, actual_data, has_scale = future_cv.result()
            
            if future_design:
                design_data = future_design.result()
            else:
                design_data = {"count": 0, "radius_mm": 0, "spacings_mm": []}
                
            revit_data = future_defect.result()

        # 4. Scoring logic (Instantaneous)
        score, table = scoring_utils.calculate_similarity_and_table(
            design_data, actual_data, has_scale
        )

        # Optimization: Drop JPEG quality to 80% to vastly speed up base64 encoding & network transfer
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode('.jpg', annotated_img, encode_param)
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

# --- SIDE VIEW ---
@app.route('/analyze/side', methods=['POST', 'OPTIONS'])
def analyze_side():
    if request.method == 'OPTIONS': return jsonify({'status': 'ok'}), 200
    try:
        # Lazy load heavy dependencies
        import cv2
        import numpy as np

        if 'real_image' not in request.files:
            return jsonify({"status": "error", "message": "No real_image provided"}), 400

        real_img = request.files['real_image']
        design_img = request.files.get('design_image') 
        
        rod_points = json.loads(request.form.get('rod_points', '[]'))
        ref_points = json.loads(request.form.get('ref_points', '[]'))
        ref_length = float(request.form.get('ref_length', 0))

        # Zero Disk I/O
        real_bytes = real_img.read()
        design_bytes = design_img.read() if design_img else None
        
        # Decode image for CV
        img_array = cv2.imdecode(np.frombuffer(real_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img_array is None:
             return jsonify({"status": "error", "message": "Could not decode image"}), 400

        # Parallel Execution
        with concurrent.futures.ThreadPoolExecutor() as executor:
            future_cv = executor.submit(
                side_view_service.process_side_view,
                img_array, rod_points, ref_points, ref_length
            )

            if design_bytes:
                future_design = executor.submit(
                    gemini_service.extract_side_design_data,
                    design_bytes
                )
            else:
                future_design = None

            annotated_img, results, has_scale = future_cv.result()
            
            if future_design:
                design_data = future_design.result()
            else:
                design_data = {"spacing_mm": 0}

        score, table = scoring_utils.calculate_side_view_score(
            design_data, results, has_scale
        )

        # Optimization: Drop JPEG quality to 80% to vastly speed up transfer
        encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        _, buffer = cv2.imencode('.jpg', annotated_img, encode_param)
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