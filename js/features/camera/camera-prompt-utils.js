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

function formatNumber(value, digits = 1) {
    return String(roundTo(value, digits));
}

function getPitchLabel(pitch) {
    if (pitch >= 60) {
        return "bird's-eye top-down";
    }
    if (pitch >= 32) {
        return 'high-angle';
    }
    if (pitch >= 12) {
        return 'slightly high-angle';
    }
    if (pitch <= -38) {
        return "worm's-eye low-angle";
    }
    if (pitch <= -16) {
        return 'low-angle';
    }
    if (pitch <= -6) {
        return 'slightly low-angle';
    }
    return 'eye-level';
}

function getPitchPlacementInstruction(pitch) {
    const absPitch = Math.abs(pitch);
    if (absPitch < 3) {
        return 'keep the camera at eye level';
    }
    if (pitch > 0) {
        return `raise the camera ${formatNumber(absPitch, 1)}° above eye level`;
    }
    return `lower the camera ${formatNumber(absPitch, 1)}° below eye level and aim upward`;
}

function getYawLabel(yaw) {
    const absYaw = Math.abs(yaw);
    const direction = getSubjectHorizontalDirection(yaw);
    if (absYaw <= 18) {
        return 'front view centered on the subject';
    }
    if (absYaw <= 68) {
        return `${direction} front three-quarter view showing the front and ${direction} side of the subject`;
    }
    if (absYaw <= 112) {
        return `${direction} side profile view showing the subject mainly from the side`;
    }
    if (absYaw <= 162) {
        return `${direction} rear three-quarter view showing the back and ${direction} side of the subject`;
    }
    return 'straight rear view showing the back of the subject';
}

function getYawPlacementInstruction(yaw) {
    const absYaw = Math.abs(yaw);
    const direction = getSubjectHorizontalDirection(yaw);
    if (absYaw <= 5) {
        return 'keep the camera centered on the subject front';
    }
    if (absYaw >= 175) {
        return 'move the camera to a full rear view behind the subject';
    }
    return `orbit the camera ${formatNumber(absYaw, 1)}° toward the subject's ${direction} side from the front reference`;
}

function getDistanceProfile(distance) {
    if (distance <= 2.4) {
        return {
            shot: 'an extreme close-up',
            goal: 'fill almost the entire frame with subject details and leave only minimal background context'
        };
    }
    if (distance <= 4) {
        return {
            shot: 'a close-up',
            goal: 'keep the subject filling most of the frame with a tight crop and limited surrounding space'
        };
    }
    if (distance <= 5.8) {
        return {
            shot: 'a medium close-up',
            goal: 'keep the subject dominant in the frame with only a small amount of surrounding context'
        };
    }
    if (distance <= 8.2) {
        return {
            shot: 'a medium shot',
            goal: 'show the subject clearly while retaining some surrounding context'
        };
    }
    if (distance <= 12) {
        return {
            shot: 'a full-body or full-object shot',
            goal: 'keep the complete subject visible with comfortable margins around it'
        };
    }
    return {
        shot: 'a long shot',
        goal: 'show the subject smaller within a wider environment and preserve clear environmental context'
    };
}

function getFovProfile(fov) {
    if (fov < 28) {
        return 'a super-telephoto lens look with strong perspective compression';
    }
    if (fov < 42) {
        return 'a telephoto lens look with compressed perspective and minimal distortion';
    }
    if (fov < 65) {
        return 'a natural standard-lens perspective';
    }
    if (fov < 86) {
        return 'a wide-angle lens perspective with visible spatial depth';
    }
    if (fov < 108) {
        return 'an ultra-wide-angle perspective with expanded space';
    }
    return 'a fisheye-like ultra-wide perspective with strong edge distortion';
}

function getRollInstruction(roll) {
    const absRoll = Math.abs(roll);
    if (absRoll < 3) {
        return 'keep roll at 0° and the horizon level';
    }
    const direction = roll > 0 ? 'clockwise' : 'counterclockwise';
    if (absRoll < 10) {
        return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a subtle Dutch angle`;
    }
    if (absRoll < 20) {
        return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a noticeable Dutch angle`;
    }
    return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a strong Dutch angle`;
}

function getSideConsistencyInstruction(yaw) {
    const absYaw = Math.abs(yaw);
    if (absYaw <= 18) {
        return 'Keep the subject front-facing relative to the camera and do not mirror the image.';
    }
    if (absYaw >= 162) {
        return 'Reach the back view by moving the camera around the subject, not by flipping or mirroring the image.';
    }
    const direction = getSubjectHorizontalDirection(yaw);
    return `Reveal the subject's ${direction} side by moving the camera around the subject, not by mirroring the image or swapping left and right details.`;
}

export function generateCameraPrompt(cameraData = {}) {
    const normalized = normalizeCameraState(cameraData);
    const { pitch, yaw, distance, fov, roll } = normalized;

    const viewpoint = dedupeSegments([
        getPitchLabel(pitch),
        getYawLabel(yaw)
    ]).join(' ');
    const distanceProfile = getDistanceProfile(distance);
    const lensProfile = getFovProfile(fov);
    const rollInstruction = getRollInstruction(roll);
    const cameraSpec = [
        `yaw ${formatNumber(yaw, 1)}°: ${getYawPlacementInstruction(yaw)}`,
        `pitch ${formatNumber(pitch, 1)}°: ${getPitchPlacementInstruction(pitch)}`,
        `distance ${formatNumber(distance, 2)}: frame as ${distanceProfile.shot}`,
        `FOV ${formatNumber(fov, 1)}°: use ${lensProfile}`,
        `roll ${formatNumber(roll, 1)}°: ${rollInstruction}`
    ].join('; ');

    return [
        'Camera-only transformation of the same subject and scene.',
        `Camera specification: ${cameraSpec}.`,
        `Expected view: ${viewpoint}.`,
        `Framing goal: ${distanceProfile.goal}.`,
        `Strict constraints: keep the same subject identity, pose, proportions, outfit or materials, lighting, background, and scene layout. Change only the camera position, viewing angle, framing, lens perspective, and tilt. ${getSideConsistencyInstruction(yaw)}`
    ].join(' ');
}
