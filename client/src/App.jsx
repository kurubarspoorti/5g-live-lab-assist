import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = "http://localhost:3000";
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function toWorkspaceSnapshot(snapshot) {
  return {
    id: snapshot.id,
    image: snapshot.data?.image || "",
    width: snapshot.metadata?.width || 0,
    height: snapshot.metadata?.height || 0,
    createdAt:
      snapshot.metadata?.createdAt || snapshot.createdAt || "",
    version: snapshot.version,
  };
}

export default function App() {
  const [role, setRole] = useState("professor");
  const [sessionCode, setSessionCode] = useState("");
  const [activeSession, setActiveSession] = useState("");
  const [connection, setConnection] = useState("Connecting...");
  const [participants, setParticipants] = useState([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [socket, setSocket] = useState(null);

  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [cameraError, setCameraError] = useState("");

  const [isDrawing, setIsDrawing] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const [selectedColor, setSelectedColor] = useState("#ff3333");
  const [snapshots, setSnapshots] = useState([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [selectionRect, setSelectionRect] = useState(null);

  const peerRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const selectionStartRef = useRef(null);

  // --------------------------------------------------
  // SOCKET CONNECTION
  // --------------------------------------------------
  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);

    newSocket.on("connect", () => setConnection("Connected"));
    newSocket.on("disconnect", () => setConnection("Disconnected"));
    newSocket.on("connect_error", () =>
      setConnection("Connection failed")
    );

    newSocket.on("session-joined", (data) => {
      setParticipants(data.participants || []);
      setActiveSession(data.code);
      setSnapshots((data.snapshots || []).map(toWorkspaceSnapshot));
      newSocket.emit("snapshot:history:request");
      setMessage(`Joined session ${data.code} as ${data.role}.`);
    });

    newSocket.on("participant-joined", (participant) => {
      setParticipants((previous) => {
        if (previous.some((p) => p.socketId === participant.socketId)) {
          return previous;
        }
        return [...previous, participant];
      });
      setMessage(`${participant.role} joined your session.`);
    });

    newSocket.on("participant-left", ({ socketId }) => {
      setParticipants((previous) =>
        previous.filter((p) => p.socketId !== socketId)
      );
      setMessage("A participant left the session.");
    });

    newSocket.on("session-error", (data) => {
      setMessage(data.message || "Could not join the session.");
    });

    // A snapshot created by either participant is shared with the room.
    newSocket.on("snapshot:created", ({ snapshot } = {}) => {
      if (!snapshot) return;

      setSnapshots((previous) => {
        if (previous.some((item) => item.id === snapshot.id)) {
          return previous;
        }
        return [toWorkspaceSnapshot(snapshot), ...previous];
      });
    });

    newSocket.on("snapshot:updated", ({ snapshot } = {}) => {
      if (!snapshot) return;

      setSnapshots((previous) =>
        previous.map((item) =>
          item.id === snapshot.id ? toWorkspaceSnapshot(snapshot) : item
        )
      );
    });

    newSocket.on("snapshot:deleted", ({ snapshotId } = {}) => {
      if (!snapshotId) return;

      setSnapshots((previous) =>
        previous.filter((item) => item.id !== snapshotId)
      );
    });

    // Rebuild the visible snapshot list from the session's history.
    newSocket.on("snapshot:history", ({ history } = {}) => {
      const snapshotsById = new Map();
      const orderedHistory = [...(history || [])].sort(
        (a, b) => (a.sequence || 0) - (b.sequence || 0)
      );

      orderedHistory.forEach((entry) => {
        if (!entry?.snapshotId) return;

        if (entry.action === "deleted") {
          snapshotsById.delete(entry.snapshotId);
        } else if (entry.snapshot) {
          snapshotsById.set(entry.snapshotId, entry.snapshot);
        }
      });

      setSnapshots(
        Array.from(snapshotsById.values())
          .reverse()
          .map(toWorkspaceSnapshot)
      );

      console.log("Snapshot history received:", history || []);
    });

    newSocket.on("snapshot:error", ({ message: errorMessage } = {}) => {
      setMessage(errorMessage || "Snapshot operation failed.");
    });

    newSocket.on(
      "snapshot:conflict",
      ({ message: conflictMessage } = {}) => {
        setMessage(conflictMessage || "This snapshot changed elsewhere.");
      }
    );

    // Shared annotation events.
    newSocket.on("annotation-update", ({ annotation } = {}) => {
      if (annotation) {
        setAnnotations((previous) => [...previous, annotation]);
      }
    });

    newSocket.on("annotation-clear", () => setAnnotations([]));

    // Professor receives the student's WebRTC offer.
    newSocket.on("webrtc-offer", async ({ offer } = {}) => {
      try {
        if (!offer) return;

        peerRef.current?.close();

        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerRef.current = pc;
        configurePeer(pc, newSocket);

        await pc.setRemoteDescription(offer);
        await flushCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        newSocket.emit("webrtc-answer", { answer: pc.localDescription });
      } catch (error) {
        console.error("Could not handle WebRTC offer:", error);
        setMessage("Could not establish video. Check the browser console.");
      }
    });

    // Student receives the professor's WebRTC answer.
    newSocket.on("webrtc-answer", async ({ answer } = {}) => {
      try {
        const pc = peerRef.current;
        if (!pc || !answer) return;

        await pc.setRemoteDescription(answer);
        await flushCandidates(pc);
      } catch (error) {
        console.error("Could not handle WebRTC answer:", error);
      }
    });

    newSocket.on("webrtc-ice-candidate", async ({ candidate } = {}) => {
      if (!candidate) return;

      const pc = peerRef.current;
      if (!pc || !pc.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.error("Could not add ICE candidate:", error);
      }
    });

    return () => {
      newSocket.disconnect();
      peerRef.current?.close();
      peerRef.current = null;
    };
  }, []);

  // --------------------------------------------------
  // WEBRTC HELPERS
  // --------------------------------------------------
  function configurePeer(pc, activeSocket) {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        activeSocket.emit("webrtc-ice-candidate", {
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams?.[0]) setRemoteStream(event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setMessage("Live video connection established!");
      } else if (pc.connectionState === "failed") {
        setMessage(
          "Video connection failed. Network or TURN configuration may be needed."
        );
      }
    };
  }

  async function flushCandidates(pc) {
    const candidates = pendingCandidatesRef.current.splice(0);

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (error) {
        console.error("Could not add queued ICE candidate:", error);
      }
    }
  }

  // Student starts the video call after joining and enabling the camera.
  useEffect(() => {
    if (
      role !== "student" ||
      !activeSession ||
      !localStream ||
      !socket?.connected
    ) {
      return;
    }

    let cancelled = false;

    async function startCall() {
      try {
        peerRef.current?.close();
        pendingCandidatesRef.current = [];

        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerRef.current = pc;
        configurePeer(pc, socket);

        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (cancelled) {
          pc.close();
          return;
        }

        socket.emit("webrtc-offer", { offer: pc.localDescription });
        setMessage("Calling the professor...");
      } catch (error) {
        console.error("Could not start WebRTC call:", error);
        setMessage("Could not start video. Check the browser console.");
      }
    }

    startCall();

    return () => {
      cancelled = true;
    };
  }, [role, activeSession, localStream, socket]);

  // --------------------------------------------------
  // CAMERA FUNCTIONS
  // --------------------------------------------------
  async function startCamera() {
    setCameraError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
    } catch (error) {
      setCameraError(
        error.name === "NotAllowedError"
          ? "Camera or microphone permission was denied. Allow access in Chrome."
          : `Could not access camera: ${error.message}`
      );
    }
  }

  function stopCamera() {
    localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
  }

  // --------------------------------------------------
  // ANNOTATION AND ROI POINTER HELPERS
  // --------------------------------------------------
  function getCanvasPoint(event) {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function startDrawing(event) {
    if (isCapturing && role === "professor") {
      startRegionSelection(event);
      return;
    }

    if (!isDrawing || role !== "professor") return;

    const canvas = canvasRef.current;
    const point = getCanvasPoint(event);
    if (!canvas || !point) return;

    drawingRef.current = true;
    lastPointRef.current = point;
    canvas.setPointerCapture(event.pointerId);

    const annotation = { from: point, to: point, color: selectedColor };
    setAnnotations((previous) => [...previous, annotation]);
    socket?.emit("annotation-update", { annotation });
  }

  function continueDrawing(event) {
    if (isCapturing && selectionStartRef.current) {
      updateRegionSelection(event);
      return;
    }

    if (!drawingRef.current || role !== "professor") return;

    const point = getCanvasPoint(event);
    if (!point) return;

    const annotation = {
      from: lastPointRef.current,
      to: point,
      color: selectedColor,
    };

    lastPointRef.current = point;
    setAnnotations((previous) => [...previous, annotation]);
    socket?.emit("annotation-update", { annotation });
  }

  function stopDrawing(event) {
    if (isCapturing && selectionStartRef.current) {
      updateRegionSelection(event);
      selectionStartRef.current = null;
      return;
    }

    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function startRegionSelection(event) {
    if (role !== "professor" || !isCapturing || !remoteStream) return;

    const point = getCanvasPoint(event);
    if (!point) return;

    selectionStartRef.current = point;
    setSelectionRect({ x: point.x, y: point.y, width: 0, height: 0 });
    canvasRef.current?.setPointerCapture(event.pointerId);
  }

  function updateRegionSelection(event) {
    const start = selectionStartRef.current;
    const point = getCanvasPoint(event);
    if (!start || !point) return;

    setSelectionRect({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }

  function beginCaptureMode() {
    if (!remoteStream || !videoRef.current) {
      setMessage("Wait for the student's live video before capturing a region.");
      return;
    }

    setIsDrawing(false);
    drawingRef.current = false;
    setSelectionRect(null);
    selectionStartRef.current = null;
    setIsCapturing(true);
    setMessage(
      "Drag over the live video to select a region, then click Save snapshot."
    );
  }

  function cancelCaptureMode() {
    setIsCapturing(false);
    setSelectionRect(null);
    selectionStartRef.current = null;
    setMessage("Region capture cancelled.");
  }

  function saveSnapshot() {
    const video = videoRef.current;
    const stage = canvasRef.current;

    if (!video || !stage || !selectionRect || video.readyState < 2) {
      setMessage("Select a region on the live video before saving.");
      return;
    }

    if (selectionRect.width < 0.01 || selectionRect.height < 0.01) {
      setMessage("The selected region is too small. Drag a larger rectangle.");
      return;
    }

    if (!socket?.connected || !activeSession) {
      setMessage("Join a session before saving a snapshot.");
      return;
    }

    // Convert the selected display rectangle to source-video pixels.
    // This accounts for object-fit: cover, including any cropped edges.
    const stageRect = stage.getBoundingClientRect();
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    if (!videoWidth || !videoHeight || !stageRect.width || !stageRect.height) {
      setMessage("The video is not ready to capture yet.");
      return;
    }

    const scale = Math.max(
      stageRect.width / videoWidth,
      stageRect.height / videoHeight
    );
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (renderedWidth - stageRect.width) / 2;
    const offsetY = (renderedHeight - stageRect.height) / 2;

    let sx = (selectionRect.x * stageRect.width + offsetX) / scale;
    let sy = (selectionRect.y * stageRect.height + offsetY) / scale;
    let sw = (selectionRect.width * stageRect.width) / scale;
    let sh = (selectionRect.height * stageRect.height) / scale;

    sx = Math.max(0, Math.min(videoWidth, sx));
    sy = Math.max(0, Math.min(videoHeight, sy));
    sw = Math.min(sw, videoWidth - sx);
    sh = Math.min(sh, videoHeight - sy);

    const cropWidth = Math.floor(sw);
    const cropHeight = Math.floor(sh);

    if (cropWidth < 2 || cropHeight < 2) {
      setMessage(
        "The selected region is outside the visible video. Please select again."
      );
      return;
    }

    const output = document.createElement("canvas");
    output.width = cropWidth;
    output.height = cropHeight;

    const context = output.getContext("2d");
    if (!context) {
      setMessage("Could not create the snapshot. Please try again.");
      return;
    }

    context.drawImage(
      video,
      sx,
      sy,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight
    );

    const image = output.toDataURL("image/png");

    socket.emit("snapshot:create", {
      data: { image },
      metadata: {
        width: cropWidth,
        height: cropHeight,
        createdAt: new Date().toLocaleTimeString(),
      },
    });

    setIsCapturing(false);
    setSelectionRect(null);
    selectionStartRef.current = null;
    setMessage("Snapshot sent to the shared workspace.");
  }

  function deleteSnapshot(snapshotId) {
    if (!socket?.connected || !activeSession) {
      setMessage("Join a session before removing a snapshot.");
      return;
    }

    socket.emit("snapshot:delete", { snapshotId });
  }

  function clearAnnotations() {
    setAnnotations([]);
    socket?.emit("annotation-clear");
  }

  // --------------------------------------------------
  // DRAW ANNOTATIONS ON CANVAS
  // --------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = rect.width * pixelRatio;
    canvas.height = rect.height * pixelRatio;

    const context = canvas.getContext("2d");
    if (!context) return;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";

    annotations.forEach((annotation) => {
      context.beginPath();
      context.strokeStyle = annotation.color;
      context.moveTo(
        annotation.from.x * rect.width,
        annotation.from.y * rect.height
      );
      context.lineTo(
        annotation.to.x * rect.width,
        annotation.to.y * rect.height
      );
      context.stroke();
    });
  }, [annotations, role, remoteStream, localStream]);

  // --------------------------------------------------
  // SESSION FUNCTIONS
  // --------------------------------------------------
  async function createSession() {
    setLoading(true);
    setMessage("");
    setParticipants([]);
    setActiveSession("");
    setAnnotations([]);
    setSnapshots([]);

    try {
      const response = await fetch(`${SERVER_URL}/api/sessions`, {
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Could not create session.");
      }

      setSessionCode(data.session.code);
      socket.emit("join-session", {
        code: data.session.code,
        role: "professor",
      });
      setMessage("Session created. Joining its room...");
    } catch (error) {
      setMessage(error.message || "Could not connect to the backend.");
    } finally {
      setLoading(false);
    }
  }

  async function joinSession(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    setParticipants([]);
    setActiveSession("");
    setAnnotations([]);
    setSnapshots([]);

    try {
      const code = sessionCode.trim().toUpperCase();
      const response = await fetch(`${SERVER_URL}/api/sessions/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Could not join the session.");
      }

      socket.emit("join-session", {
        code: data.session.code,
        role: "student",
      });
    } catch (error) {
      setMessage(error.message || "Could not connect to the backend.");
    } finally {
      setLoading(false);
    }
  }

  function changeRole(newRole) {
    setRole(newRole);
    setActiveSession("");
    setParticipants([]);
    setAnnotations([]);
    setSnapshots([]);
    setIsDrawing(false);
    setIsCapturing(false);
    setSelectionRect(null);
    selectionStartRef.current = null;
    setMessage("");

    peerRef.current?.close();
    peerRef.current = null;
    setRemoteStream(null);
  }

  // --------------------------------------------------
  // VIDEO VIEW
  // --------------------------------------------------
  function renderVideo() {
    const stream = role === "student" ? localStream : remoteStream;

    return (
      <div className="video-stage">
        {stream ? (
          <video
            autoPlay
            playsInline
            muted={role === "student"}
            ref={(element) => {
              videoRef.current = element;
              if (element && element.srcObject !== stream) {
                element.srcObject = stream;
              }
            }}
          />
        ) : (
          <div className="video-placeholder">
            {role === "student"
              ? "Your camera preview will appear here."
              : "Student video will appear here after the WebRTC connection."}
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="annotation-canvas"
          onPointerDown={startDrawing}
          onPointerMove={continueDrawing}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          onLostPointerCapture={stopDrawing}
          style={{
            pointerEvents:
              role === "professor" && (isDrawing || isCapturing)
                ? "auto"
                : "none",
            cursor: isCapturing
              ? "crosshair"
              : isDrawing
                ? "crosshair"
                : "default",
          }}
        />

        {selectionRect && (
          <div
            className="roi-selection"
            style={{
              left: `${selectionRect.x * 100}%`,
              top: `${selectionRect.y * 100}%`,
              width: `${selectionRect.width * 100}%`,
              height: `${selectionRect.height * 100}%`,
            }}
          />
        )}
      </div>
    );
  }

  // --------------------------------------------------
  // MAIN UI
  // --------------------------------------------------
  return (
    <main className="app">
      <header className="topbar">
        <div className="brand-mark">5G</div>
        <div>
          <h1>Live Lab Assist</h1>
          <p>Real-time remote laboratory collaboration</p>
        </div>
        <span
          className={`status ${connection === "Connected" ? "online" : ""}`}
        >
          <span className="status-dot" />
          {connection}
        </span>
      </header>

      <section className="hero">
        <p className="eyebrow">REMOTE LABORATORY</p>
        <h2>Learn, guide, and solve together.</h2>
        <p>
          Connect a student's live lab view with a professor's guidance and a
          shared workspace.
        </p>
      </section>

      <section className="panel">
        <h2>Get started</h2>
        <p className="muted">Choose how you want to use the lab.</p>

        <div className="role-picker">
          <button
            type="button"
            className={role === "professor" ? "role selected" : "role"}
            onClick={() => changeRole("professor")}
          >
            <span className="role-icon">✦</span>
            <strong>Professor</strong>
            <span>Create a new session</span>
          </button>

          <button
            type="button"
            className={role === "student" ? "role selected" : "role"}
            onClick={() => changeRole("student")}
          >
            <span className="role-icon">⌁</span>
            <strong>Student</strong>
            <span>Join an existing session</span>
          </button>
        </div>

        {role === "professor" ? (
          <div className="action-area">
            <button
              className="primary-button"
              onClick={createSession}
              disabled={loading || !socket?.connected}
            >
              {loading ? "Creating..." : "Create session"}
            </button>
          </div>
        ) : (
          <form className="action-area" onSubmit={joinSession}>
            <label htmlFor="sessionCode">Session code</label>
            <input
              id="sessionCode"
              value={sessionCode}
              onChange={(event) =>
                setSessionCode(event.target.value.toUpperCase())
              }
              placeholder="Enter the professor's code"
              maxLength={6}
              required
            />
            <button
              className="primary-button"
              type="submit"
              disabled={loading || !socket?.connected}
            >
              {loading ? "Joining..." : "Join session"}
            </button>
          </form>
        )}

        {message && (
          <p className="message" role="status">
            {message}
          </p>
        )}

        {activeSession && (
          <div className="session-card">
            <span className="muted">Session code</span>
            <strong className="session-code">{activeSession}</strong>

            {role === "professor" && (
              <button
                className="secondary-button"
                onClick={() => navigator.clipboard.writeText(activeSession)}
              >
                Copy session code
              </button>
            )}

            <h3>Participants in this room</h3>

            {participants.length === 0 ? (
              <p className="muted">Waiting for the other participant...</p>
            ) : (
              <ul>
                {participants.map((participant) => (
                  <li key={participant.socketId}>
                    {participant.role === "professor" ? "Professor" : "Student"}{" "}
                    connected
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="panel camera-panel">
        <h2>Live camera</h2>
        <p className="muted">
          The student shares video after joining a session.
        </p>

        {role === "student" && (
          <div className="action-area">
            {!localStream ? (
              <button className="primary-button" onClick={startCamera}>
                Enable camera and microphone
              </button>
            ) : (
              <button className="secondary-button" onClick={stopCamera}>
                Stop camera
              </button>
            )}

            {cameraError && (
              <p className="message" role="alert">
                {cameraError}
              </p>
            )}
          </div>
        )}

        {role === "professor" && (
          <div>
            <h3>Student's live video</h3>
            <div className="annotation-toolbar">
              <button
                type="button"
                onClick={() => {
                  setIsCapturing(false);
                  setSelectionRect(null);
                  setIsDrawing((previous) => !previous);
                }}
                disabled={!remoteStream}
              >
                {isDrawing ? "Stop drawing" : "Start drawing"}
              </button>

              <input
                type="color"
                value={selectedColor}
                onChange={(event) => setSelectedColor(event.target.value)}
                aria-label="Drawing color"
              />

              <button type="button" onClick={clearAnnotations}>
                Clear drawings
              </button>

              <button
                type="button"
                onClick={beginCaptureMode}
                disabled={!remoteStream}
              >
                Capture region
              </button>

              {isCapturing && (
                <>
                  <button
                    type="button"
                    onClick={saveSnapshot}
                    disabled={!selectionRect}
                  >
                    Save snapshot
                  </button>
                  <button type="button" onClick={cancelCaptureMode}>
                    Cancel
                  </button>
                </>
              )}
            </div>

            {isCapturing && (
              <p className="muted">
                Drag over the video to select the region you want to save.
              </p>
            )}
          </div>
        )}

        <div className="video-grid">{renderVideo()}</div>

        {role === "student" && (
          <p className="muted">
            The professor's annotations will appear over your camera view.
          </p>
        )}
      </section>

      {/* Shared workspace is visible to both professor and student. */}
      {activeSession && (
        <section className="panel workspace-panel">
          <h2>Shared snapshots workspace</h2>
          <p className="muted">
            Snapshots captured by the professor are shared with participants
            in this session.
          </p>

          {snapshots.length === 0 ? (
            <p className="muted">No snapshots have been shared yet.</p>
          ) : (
            <div className="snapshot-grid">
              {snapshots.map((snapshot, index) => (
                <article className="snapshot-card" key={snapshot.id}>
                  <img
                    src={snapshot.image}
                    alt={`Shared snapshot ${index + 1}`}
                  />
                  <div className="snapshot-details">
                    <strong>Snapshot {snapshots.length - index}</strong>
                    <span>
                      {snapshot.width} × {snapshot.height}px ·{" "}
                      {snapshot.createdAt}
                    </span>

                    {role === "professor" && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => deleteSnapshot(snapshot.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <footer>5G Live Lab Assist · Local development prototype</footer>
    </main>
  );
}