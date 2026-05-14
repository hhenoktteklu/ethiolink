// EthioLink — staff-domain request-body validators.
//
// Staff bodies are simpler than services bodies: two plain-text fields
// (no LocalizedText, no numerics). This file is mostly a re-export of
// generic helpers from `shared/http/validation.ts` plus the
// staff-domain field caps.

export {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredString,
    parseStringOrNull,
} from '../../shared/http/validation.js';

export const FieldLimits = Object.freeze({
    DISPLAY_NAME_MAX: 200,
    ROLE_MAX: 100,
});
