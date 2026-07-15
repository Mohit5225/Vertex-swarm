export interface ProtocolCheckResult {
    valid: boolean;
    warning?: string;
    error?: string;
}

export function validateProtocolVersion(expected: string, actual?: string): ProtocolCheckResult {
    if (!actual) {
        return { valid: false, error: "Backend did not return a protocol version." };
    }
    
    const expectedParts = expected.split('.');
    const actualParts = actual.split('.');
    
    // Major version must match exactly
    if (expectedParts[0] !== actualParts[0]) {
        return { 
            valid: false, 
            error: `Protocol major version mismatch. Extension requires ${expectedParts[0]}.x but backend is ${actualParts[0]}.x. Please update Vertex Swarm.` 
        };
    }
    
    // Minor version mismatch warns but is allowed
    if (expectedParts.length > 1 && actualParts.length > 1 && expectedParts[1] !== actualParts[1]) {
        return { 
            valid: true, 
            warning: `Protocol minor version mismatch. Extension expects ${expected} but backend is ${actual}. Proceeding with caution.` 
        };
    }
    
    return { valid: true };
}
