/** Fixed source handoff order. Orchestration requires a separate image-bound gate. */
export const independentPromotionPredecessor=Object.freeze({controls:null,search:'controls',email:'search',images:'email',media:'images'});
export const independentPromotionRoles=Object.freeze(Object.keys(independentPromotionPredecessor));

/** Capacity metadata is not actual allocation/statfs/canary or recovery evidence. */
export function denyUnprovedMediaPromotion(){throw new Error('CLOUD_RUN_MEDIA_NATIVE_CAPACITY_PROOF_REQUIRED');}
