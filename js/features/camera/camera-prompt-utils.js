export const DEFAULT_CAMERA_STATE = Object.freeze({
    pitch: 12,
    yaw: 28,
    distance: 6.5,
    fov: 50,
    roll: 0
});

export const CAMERA_LIMITS = Object.freeze({
    pitch: { min: -85, max: 85 },
    yaw: { min: -180, max: 180 },
    distance: { min: 1.4, max: 18 },
    fov: { min: 18, max: 120 },
    roll: { min: -45, max: 45 }
});

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function roundTo(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
}

export function normalizeAngle(value) {
    let angle = Number(value) || 0;
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
}

export function normalizeCameraState(raw = {}) {
    return {
        pitch: clamp(roundTo(raw.pitch ?? DEFAULT_CAMERA_STATE.pitch, 1), CAMERA_LIMITS.pitch.min, CAMERA_LIMITS.pitch.max),
        yaw: clamp(roundTo(normalizeAngle(raw.yaw ?? DEFAULT_CAMERA_STATE.yaw), 1), CAMERA_LIMITS.yaw.min, CAMERA_LIMITS.yaw.max),
        distance: clamp(roundTo(raw.distance ?? DEFAULT_CAMERA_STATE.distance, 2), CAMERA_LIMITS.distance.min, CAMERA_LIMITS.distance.max),
        fov: clamp(roundTo(raw.fov ?? DEFAULT_CAMERA_STATE.fov, 1), CAMERA_LIMITS.fov.min, CAMERA_LIMITS.fov.max),
        roll: clamp(roundTo(raw.roll ?? DEFAULT_CAMERA_STATE.roll, 1), CAMERA_LIMITS.roll.min, CAMERA_LIMITS.roll.max)
    };
}

function dedupeSegments(segments = []) {
    const seen = new Set();
    return segments.filter((segment) => {
        const key = String(segment || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getSubjectHorizontalDirection(yaw) {
    // In this scene setup, positive yaw moves the camera toward +X while staying
    // in front of the subject, which reveals the subject's right side.
    return yaw >= 0 ? 'right' : 'left';
}

function getPitchInstruction(pitch) {
    if (pitch >= 60) {
        return "bird's-eye top-down view, with the camera looking steeply down at the subject";
    }
    if (pitch >= 32) {
        return 'high-angle view, with the camera above the subject looking down';
    }
    if (pitch >= 12) {
        return 'slightly high-angle view, with the camera a little above eye level';
    }
    if (pitch <= -38) {
        return "worm's-eye low-angle view, with the camera very low and looking up";
    }
    if (pitch <= -16) {
        return 'low-angle view, with the camera below the subject looking up';
    }
    if (pitch <= -6) {
        return 'subtle low-angle view, with the camera just below eye level';
    }
    return 'eye-level view';
}

function getYawInstruction(yaw) {
    const absYaw = Math.abs(yaw);
    const direction = getSubjectHorizontalDirection(yaw);
    if (absYaw <= 18) {
        return 'straight-on front view, centered on the subject';
    }
    if (absYaw <= 68) {
        return `${direction} front three-quarter view, showing the front and ${direction} side of the subject`;
    }
    if (absYaw <= 112) {
        return `${direction} side profile view, showing the subject mainly from the side`;
    }
    if (absYaw <= 162) {
        return `${direction} rear three-quarter view, showing the back and ${direction} side of the subject`;
    }
    return 'straight rear view, showing the back of the subject';
}

function getDistanceInstruction(distance) {
    if (distance <= 2.4) {
        return 'extreme close-up framing, filling the image with the subject details';
    }
    if (distance <= 4) {
        return 'close-up framing, focusing tightly on the subject';
    }
    if (distance <= 5.8) {
        return 'medium close-up framing, keeping the subject dominant in the composition';
    }
    if (distance <= 8.2) {
        return 'medium shot framing, showing the subject clearly with some surrounding context';
    }
    if (distance <= 12) {
        return 'full-body or full-object framing, keeping the complete subject visible';
    }
    return 'long shot wide framing, showing the subject smaller within the environment';
}

function getFovInstruction(fov) {
    if (fov < 28) {
        return 'super-telephoto lens look with strong perspective compression';
    }
    if (fov < 42) {
        return 'telephoto lens look with compressed perspective and minimal distortion';
    }
    if (fov < 65) {
        return 'natural standard-lens perspective';
    }
    if (fov < 86) {
        return 'wide-angle lens perspective with visible spatial depth';
    }
    if (fov < 108) {
        return 'ultra-wide-angle perspective with expanded space';
    }
    return 'fisheye-like ultra-wide perspective with strong edge distortion';
}

function getRollInstruction(roll) {
    const absRoll = Math.abs(roll);
    if (absRoll < 6) {
        return 'Keep the horizon level.';
    }
    const direction = roll > 0 ? 'clockwise' : 'counterclockwise';
    if (absRoll >= 16) {
        return `Use a strong Dutch angle, tilted ${direction}.`;
    }
    return `Use a slight Dutch angle, tilted ${direction}.`;
}

export function generateCameraPrompt(cameraData = {}) {
    const pitch = Number(cameraData.pitch) || 0;
    const yaw = normalizeAngle(cameraData.yaw);
    const distance = Number(cameraData.distance) || DEFAULT_CAMERA_STATE.distance;
    const fov = Number(cameraData.fov) || DEFAULT_CAMERA_STATE.fov;
    const roll = Number(cameraData.roll) || 0;

    const viewpoint = dedupeSegments([
        getPitchInstruction(pitch),
        getYawInstruction(yaw)
    ]).join(', ');
    const framing = getDistanceInstruction(distance);
    const lens = getFovInstruction(fov);
    const rollInstruction = getRollInstruction(roll);

    return [
        `Camera viewpoint instruction: ${viewpoint}.`,
        `Frame the subject with ${framing}.`,
        `Use ${lens}.`,
        rollInstruction,
        'Preserve the subject identity and scene content; change only the camera angle, framing, lens perspective, and tilt.'
    ].join(' ');
}
