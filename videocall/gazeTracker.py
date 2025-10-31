import cv2, mediapipe as mp, numpy as np, time, math
from sklearn.preprocessing import PolynomialFeatures
from sklearn.linear_model import Ridge
from filterpy.kalman import KalmanFilter
import ctypes

# ---------------- Helper: 1-Euro smoother ----------------
class OneEuroFilter:
    def __init__(self, freq=60, min_cutoff=0.4, beta=0.007):
        self.freq = freq; self.min_cutoff = min_cutoff; self.beta = beta
        self.x_prev = None; self.dx_prev = 0; self.last_t = None

    def _alpha(self, cutoff):
        tau = 1.0 / (2 * math.pi * cutoff)
        te = 1.0 / self.freq
        return 1.0 / (1.0 + tau / te)

    def __call__(self, x):
        t = time.time()
        if self.last_t is None:
            self.last_t = t; self.x_prev = x; return x
        dt = t - self.last_t; self.last_t = t
        self.freq = 1.0 / dt if dt > 0 else self.freq
        dx = (x - self.x_prev) * self.freq
        a_d = self._alpha(1.0)
        dx_hat = a_d * dx + (1 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = self._alpha(cutoff)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev, self.dx_prev = x_hat, dx_hat
        return x_hat


# ---------------- GazeTracker ----------------
class GazeTracker:
    def __init__(self):
        mp_face_mesh = mp.solutions.face_mesh
        self.mesh = mp_face_mesh.FaceMesh(refine_landmarks=True, max_num_faces=1)
        self.poly = PolynomialFeatures(degree=3)
        self.model_x = Ridge(alpha=0.001)
        self.model_y = Ridge(alpha=0.001)
        self.smooth_x, self.smooth_y = OneEuroFilter(), OneEuroFilter()

        user32 = ctypes.windll.user32
        user32.SetProcessDPIAware()
        self.screen_w, self.screen_h = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        self.kf = self._init_kalman()
        print(f"🖥 Screen: {self.screen_w}x{self.screen_h}")

    def _init_kalman(self):
        kf = KalmanFilter(dim_x=4, dim_z=2)
        dt = 1.0
        kf.F = np.array([[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]])
        kf.H = np.array([[1,0,0,0],[0,1,0,0]])
        kf.P *= 1000; kf.R *= 10
        return kf

    # ---------------- Estimate 3D head pose ----------------
    def _head_pose(self, lm, frame_shape):
        # Using a few stable landmarks for solvePnP
        landmarks_2d = np.array([
            [lm[33].x, lm[33].y],   # Left eye outer
            [lm[263].x, lm[263].y], # Right eye outer
            [lm[1].x, lm[1].y],     # Nose tip
            [lm[61].x, lm[61].y],   # Left mouth corner
            [lm[291].x, lm[291].y], # Right mouth corner
            [lm[199].x, lm[199].y], # Chin
        ], dtype=np.float32)

        landmarks_3d = np.array([
            [-30, 0, -30],   # Left eye outer
            [30, 0, -30],    # Right eye outer
            [0, 0, 0],       # Nose tip
            [-20, -30, -30], # Left mouth corner
            [20, -30, -30],  # Right mouth corner
            [0, -65, -30],   # Chin
        ], dtype=np.float32)

        fh, fw = frame_shape
        cam_matrix = np.array([
            [fw, 0, fw / 2],
            [0, fw, fh / 2],
            [0, 0, 1]
        ], dtype=np.float32)
        dist_coeffs = np.zeros((4, 1))

        success, rot_vec, trans_vec = cv2.solvePnP(
            landmarks_3d, landmarks_2d, cam_matrix, dist_coeffs, flags=cv2.SOLVEPNP_ITERATIVE
        )

        if not success:
            return 0, 0, 0

        rmat, _ = cv2.Rodrigues(rot_vec)
        # Extract Euler angles (in radians)
        sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
        pitch = math.atan2(-rmat[2, 0], sy)
        yaw = math.atan2(rmat[1, 0], rmat[0, 0])
        roll = math.atan2(rmat[2, 1], rmat[2, 2])
        return yaw, pitch, roll

    def _get_features(self, lm, frame_shape):
        iris_l, iris_r = lm[468], lm[473]
        left_outer, left_inner = lm[33], lm[133]
        right_outer, right_inner = lm[362], lm[263]
        top_l, bot_l = lm[386], lm[374]
        top_r, bot_r = lm[159], lm[145]

        horiz_l = (iris_l.x - left_outer.x)/(left_inner.x - left_outer.x)
        horiz_r = (iris_r.x - right_outer.x)/(right_inner.x - right_outer.x)
        vert_l = (iris_l.y - top_l.y)/(bot_l.y - top_l.y)
        vert_r = (iris_r.y - top_r.y)/(bot_r.y - top_r.y)
        h = (horiz_l + horiz_r)/2
        v = (vert_l + vert_r)/2

        yaw, pitch, roll = self._head_pose(lm, frame_shape)
        return np.array([h, v, yaw, pitch, roll])

    # ---------------- Calibration ----------------
    def calibrate(self):
        print("📍 Calibration started (9 points). Follow the red dot and keep your head roughly steady.")
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            raise RuntimeError("❌ Cannot access webcam")

        pts = [
            (0.2, 0.2), (0.5, 0.2), (0.8, 0.2),
            (0.2, 0.5), (0.5, 0.5), (0.8, 0.5),
            (0.2, 0.8), (0.5, 0.8), (0.8, 0.8)
        ]

        X, yx, yy = [], [], []

        cv2.namedWindow("calibration", cv2.WND_PROP_FULLSCREEN)
        cv2.setWindowProperty("calibration", cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)

        for idx, (px, py) in enumerate(pts):
            start_time = time.time()
            samples = []
            print(f"🔴 Point {idx+1}/9 at ({px:.1f}, {py:.1f})")

            while time.time() - start_time < 2.5:
                ret, frame = cap.read()
                if not ret: continue
                frame = cv2.flip(frame, 1)
                fh, fw = frame.shape[:2]
                cx, cy = int(px * fw), int(py * fh)

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = self.mesh.process(rgb)

                frame[:] = (0, 0, 0)
                cv2.circle(frame, (cx, cy), int(0.03 * fh), (0, 0, 255), -1)
                cv2.putText(frame, f"Point {idx+1}/9", (50, 100),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
                cv2.imshow("calibration", frame)

                key = cv2.waitKey(1) & 0xFF
                if key == 27:
                    print("❌ Calibration aborted.")
                    cap.release(); cv2.destroyAllWindows(); return

                if res.multi_face_landmarks:
                    lm = res.multi_face_landmarks[0].landmark
                    feat = self._get_features(lm, (fh, fw))
                    samples.append(feat)

            if samples:
                X.extend(samples)
                yx.extend([cx] * len(samples))
                yy.extend([cy] * len(samples))

            time.sleep(0.4)

        cap.release(); cv2.destroyAllWindows()

        X = np.array(X)
        yx = np.array(yx)
        yy = np.array(yy)
        Phi = self.poly.fit_transform(X)
        self.model_x.fit(Phi, yx)
        self.model_y.fit(Phi, yy)
        print("✅ Calibration complete — model fitted successfully!")

    # ---------------- Tracking ----------------
    def run(self):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            raise RuntimeError("❌ Cannot access webcam")
        print("🎯 Tracking started. Press ESC to quit.")

        cv2.namedWindow("GazeTracker", cv2.WND_PROP_FULLSCREEN)
        cv2.setWindowProperty("GazeTracker", cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)

        while True:
            ret, frame = cap.read()
            if not ret: break
            frame = cv2.flip(frame, 1)
            fh, fw = frame.shape[:2]

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = self.mesh.process(rgb)
            if res.multi_face_landmarks:
                lm = res.multi_face_landmarks[0].landmark
                feat = self._get_features(lm, (fh, fw))
                phi = self.poly.transform([feat])
                gx = self.model_x.predict(phi)[0]
                gy = self.model_y.predict(phi)[0]
                self.kf.predict()
                self.kf.update([gx, gy])
                x, y = self.kf.x[0], self.kf.x[1]
                x = self.smooth_x(x)
                y = self.smooth_y(y)
                cv2.circle(frame, (int(x), int(y)), 25, (0, 0, 255), -1)

            frame_resized = cv2.resize(frame, (self.screen_w, self.screen_h))
            cv2.imshow("GazeTracker", frame_resized)
            if cv2.waitKey(1) & 0xFF == 27:
                break

        cap.release(); cv2.destroyAllWindows()


# ---------------- Main ----------------
if __name__ == "__main__":
    gt = GazeTracker()
    gt.calibrate()
    gt.run()
