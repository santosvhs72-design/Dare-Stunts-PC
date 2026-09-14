// Every shader in this repository starts with this and nothing else.
//
// The television version lost an afternoon to a rule of GLSL ES that only
// shows up once a uniform is read from both stages: the two declarations have
// to agree on precision, or the program refuses to link -- and a vertex shader
// with no `precision` directive of its own is highp by the language's own
// default, while a fragment shader that says `precision mediump float` is not.
// Nothing in the error message says so.
//
// A multi-pass renderer has several times as many shared uniforms and several
// times as many chances to get that wrong, so the fix here is structural
// rather than careful: one preamble, highp in both stages, prepended to every
// source. There is now no declaration left that could disagree with another.
// On a PC highp costs nothing; on the television, where it would have, this
// whole repository would not exist.
export const PREAMBLE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DShadow;
`;

export const glsl = src => PREAMBLE + src;
