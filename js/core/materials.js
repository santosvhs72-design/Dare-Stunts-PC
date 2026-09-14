// What each part of the world is made of.
//
// On the television these numbers were arguments at the call site -- the road
// was drawn with 0.72, the tunnel with 0.5, and knowing why meant reading
// Game.render. There was nothing wrong with that while there was one number
// per group and one pass to hand it to. There is about to be a shadow pass, a
// specular term and a headlight, and a group of meshes needs to answer the
// same questions in all of them, so the answers live in one place with names.
//
// `ambient` is how lit a surface is with the sun taken away -- by a cloud, by
// a viaduct, by being inside a tunnel. The sun adds on top of it, so a number
// here is the bottom of the range and not the middle of it.
//
// These are lower than the television's, and that is what makes a shadow
// visible at all: there, the floor was high enough that removing the sun
// entirely changed a surface by about a tenth, which is nothing. Full sunlight
// comes out within a few percent of where it always was; the shade is a third
// darker than it. What is genuinely much darker now is everything the sun was
// never reaching anyway -- the inside of a loop, the bore of a tunnel -- and
// that is the other half of what this buys.
//
// `specular` is how much of a highlight a surface returns, and `shine` how
// tight -- a big number is a small, hard glint, a small one a broad sheen.
// Only things that are actually smooth get any: tarmac after a hot afternoon,
// poured concrete, painted steel. Grass and leaves are at zero and come out
// looking exactly as they always did, which is the point of it being a
// material property rather than a switch in the shader.
export const MAT = {
  // Grass, to the horizon. Matte, and the one thing that casts no shadow:
  // it is a flat plane with nothing under it, so the only thing it could
  // ever shadow is itself.
  GROUND: { ambient: 0.52, specular: 0, shine: 1, casts: false },
  // Trees, marker posts, the distant hills.
  SCENERY: { ambient: 0.46, specular: 0, shine: 1 },
  // Tarmac, kerbs, barriers, pillars, tunnel facades. The glint sliding along
  // this as the car turns is the single most visible thing in this file.
  ROAD: { ambient: 0.55, specular: 0.34, shine: 48 },
  // The bore of a tunnel: darker than anything else, so it feels enclosed.
  // Concrete, so the sheen is broader and weaker than the road's.
  TUNNEL: { ambient: 0.34, specular: 0.20, shine: 28 },
  // Start, checkpoint and finish gantries: painted steel.
  GATES: { ambient: 0.50, specular: 0.26, shine: 38 },
};

// A material for something the world does not own -- the ghost, the replay
// car -- built from whatever the caller decided about it.
export const surface = (ambient, specular = 0.3, shine = 40) =>
  ({ ambient, specular, shine });
