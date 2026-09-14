// What each part of the world is made of.
//
// On the television these numbers were arguments at the call site -- the road
// was drawn with 0.72, the tunnel with 0.5, and knowing why meant reading
// Game.render. There was nothing wrong with that while there was one number
// per group and one pass to hand it to. There is about to be a shadow pass, a
// specular term and a headlight, and a group of meshes needs to answer the
// same questions in all of them, so the answers live in one place with names.
//
// `ambient` is a brightness floor, not a mix weight: the inside of a loop
// faces away from the sun and still has to be readable to drive through.
export const MAT = {
  // Grass, to the horizon. Matte.
  GROUND: { ambient: 0.66 },
  // Trees, marker posts, the distant hills.
  SCENERY: { ambient: 0.58 },
  // Tarmac, kerbs, barriers, pillars, tunnel facades.
  ROAD: { ambient: 0.72 },
  // The bore of a tunnel: darker than anything else, so it feels enclosed.
  TUNNEL: { ambient: 0.50 },
  // Start, checkpoint and finish gantries.
  GATES: { ambient: 0.66 },
};
