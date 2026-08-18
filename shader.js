// SPDX-License-Identifier: GPL-3.0-or-later
//
// GB DMG Grid Shader — 5-pass WebGL2 pipeline
// Copyright (C) 2013 Harlequin <unknown92835@gmail.com>
//
// Adapted for WebGL2 from libretro/slang-shaders:
// https://github.com/libretro/slang-shaders/tree/master/handheld/shaders/gameboy
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

const _GB_W = 160, _GB_H = 144;

// ── GLSL sources (verbatim from compiled_shaders/) ───────────────────────────

const PASS0_VERT = `#version 300 es
uniform mat4 LIBRA_UBO_VERTEX_INSTANCE_MVP;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_OutputSize;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_SourceSize;
uniform float LIBRA_PUSH_VERTEX_INSTANCE_video_scale;
layout(location=0) in vec4 Position;
layout(location=1) in vec2 TexCoord;
out vec2 vTexCoord;
out vec2 dot_size;
out vec2 one_texel;
void main(){
  vec2 scaled_video_out = LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.xy * vec2(LIBRA_PUSH_VERTEX_INSTANCE_video_scale);
  gl_Position = (LIBRA_UBO_VERTEX_INSTANCE_MVP * Position) / vec4(LIBRA_PUSH_VERTEX_INSTANCE_OutputSize.xy / scaled_video_out, 1.0, 1.0);
  vTexCoord = TexCoord;
  dot_size = LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.zw;
  one_texel = vec2(1.0) / (LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.xy * LIBRA_PUSH_VERTEX_INSTANCE_video_scale);
}`;

const PASS0_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform vec4 LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_baseline_alpha;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_grey_balance;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_response_time;
uniform highp sampler2D Source;
uniform highp sampler2D COLOR_PALETTE;
in vec2 vTexCoord;
in vec2 dot_size;
in vec2 one_texel;
layout(location=0) out vec4 FragColor;
void main(){
  float is_on_dot = 0.0;
  if (one_texel.x >= dot_size.x) {
    is_on_dot = 1.0;
  } else {
    bool _h = mod(vTexCoord.x, dot_size.x) > one_texel.x;
    bool _v = _h && (mod(vTexCoord.y, dot_size.y * 1.0001) > one_texel.y);
    if(_v) is_on_dot = 1.0;
  }
  vec3 input_rgb = abs(vec3(1.0) - texture(Source, vTexCoord).xyz);
  float rgb_to_alpha = ((input_rgb.x + input_rgb.y + input_rgb.z) / LIBRA_PUSH_FRAGMENT_INSTANCE_grey_balance)
                     + (is_on_dot * LIBRA_PUSH_FRAGMENT_INSTANCE_baseline_alpha);
  vec4 out_color = vec4(texture(COLOR_PALETTE, vec2(0.75, 0.5)).xyz, rgb_to_alpha);
  out_color.w *= is_on_dot;
  FragColor = out_color;
}`;

const PASS1_VERT = `#version 300 es
uniform mat4 LIBRA_UBO_VERTEX_INSTANCE_MVP;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_OutputSize;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_OriginalSize;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_SourceSize;
uniform float LIBRA_PUSH_VERTEX_INSTANCE_video_scale;
layout(location=0) in vec4 Position;
layout(location=1) in vec2 TexCoord;
out vec2 vTexCoord;
out vec2 blur_coords_down, blur_coords_up, blur_coords_right, blur_coords_left;
out vec2 blur_coords_downright, blur_coords_downleft, blur_coords_upright, blur_coords_upleft;
out vec2 blur_coords_lower_bound, blur_coords_upper_bound;
out vec2 lcd_bounds_upleft, lcd_bounds_downright;
void main(){
  gl_Position = LIBRA_UBO_VERTEX_INSTANCE_MVP * Position;
  vTexCoord = TexCoord;
  vec2 texel = LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.zw;
  blur_coords_down       = vTexCoord + vec2(0.0,  texel.y);
  blur_coords_up         = vTexCoord + vec2(0.0, -texel.y);
  blur_coords_right      = vTexCoord + vec2( texel.x, 0.0);
  blur_coords_left       = vTexCoord + vec2(-texel.x, 0.0);
  blur_coords_downright  = vTexCoord + vec2( texel.x,  texel.y);
  blur_coords_downleft   = vTexCoord + vec2(-texel.x,  texel.y);
  blur_coords_upright    = vTexCoord + vec2( texel.x, -texel.y);
  blur_coords_upleft     = vTexCoord + vec2(-texel.x, -texel.y);
  blur_coords_lower_bound = vec2(0.0);
  blur_coords_upper_bound = texel * (LIBRA_PUSH_VERTEX_INSTANCE_OutputSize.xy - vec2(2.0));
  vec2 half_lcd_size = vec2(0.5) * ((LIBRA_PUSH_VERTEX_INSTANCE_OriginalSize.xy * LIBRA_PUSH_VERTEX_INSTANCE_video_scale) / LIBRA_PUSH_VERTEX_INSTANCE_OutputSize.xy);
  lcd_bounds_upleft    = vec2(0.5) - half_lcd_size;
  lcd_bounds_downright = vec2(0.5) + half_lcd_size;
}`;

const PASS1_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_blending_mode;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_adjacent_texel_alpha_blending;
uniform highp sampler2D Source;
in vec2 vTexCoord;
in vec2 blur_coords_lower_bound, blur_coords_upper_bound;
in vec2 blur_coords_left, blur_coords_right, blur_coords_up, blur_coords_down;
in vec2 blur_coords_upleft, blur_coords_upright, blur_coords_downleft, blur_coords_downright;
in vec2 lcd_bounds_upleft, lcd_bounds_downright;
layout(location=0) out vec4 FragColor;
float ca(vec2 c){ return texture(Source, clamp(c, blur_coords_lower_bound, blur_coords_upper_bound)).w; }
bool is_gap(vec2 a, vec2 b){ return texture(Source,a).w==0.0 && texture(Source,b).w==0.0; }
void main(){
  vec4 out_color = texture(Source, vTexCoord);
  if(LIBRA_PUSH_FRAGMENT_INSTANCE_blending_mode == 1.0){
    out_color.w += ((ca(blur_coords_up)-out_color.w + ca(blur_coords_down)-out_color.w
                   + ca(blur_coords_right)-out_color.w + ca(blur_coords_left)-out_color.w) / 4.0)
                  * LIBRA_PUSH_FRAGMENT_INSTANCE_adjacent_texel_alpha_blending;
  } else {
    if(out_color.w == 0.0){
      bool gh = is_gap(blur_coords_left, blur_coords_right);
      bool gv = is_gap(blur_coords_up, blur_coords_down);
      if(gh && gv)
        out_color.w = (ca(blur_coords_upleft)+ca(blur_coords_upright)+ca(blur_coords_downleft)+ca(blur_coords_downright)) / 4.0;
      else if(gh)
        out_color.w = (ca(blur_coords_up)+ca(blur_coords_down)) / 2.0;
      else if(gv)
        out_color.w = (ca(blur_coords_right)+ca(blur_coords_left)) / 2.0;
      out_color.w *= LIBRA_PUSH_FRAGMENT_INSTANCE_adjacent_texel_alpha_blending;
    }
  }
  if(vTexCoord.x < lcd_bounds_upleft.x || vTexCoord.x > lcd_bounds_downright.x ||
     vTexCoord.y < lcd_bounds_upleft.y || vTexCoord.y > lcd_bounds_downright.y)
    out_color = vec4(0.0);
  FragColor = out_color;
}`;

const PASS2_VERT = `#version 300 es
uniform mat4 LIBRA_UBO_VERTEX_INSTANCE_MVP;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_OutputSize;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_SourceSize;
layout(location=0) in vec4 Position;
layout(location=1) in vec2 TexCoord;
out vec2 vTexCoord;
out vec2 texel;
out vec2 lower_bound, upper_bound;
void main(){
  gl_Position = LIBRA_UBO_VERTEX_INSTANCE_MVP * Position;
  vTexCoord = TexCoord;
  texel = LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.zw;
  lower_bound = vec2(0.0);
  upper_bound = texel * (LIBRA_PUSH_VERTEX_INSTANCE_OutputSize.xy - vec2(1.0));
}`;

const PASS2_FRAG = `#version 300 es
precision highp float;
uniform vec4 LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur1;
uniform highp sampler2D Source;
in vec2 vTexCoord;
in vec2 texel, lower_bound, upper_bound;
layout(location=0) out vec4 FragColor;
void main(){
  float w[5]; w[0]=0.13; w[1]=0.13; w[2]=0.13-(LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur1/100.0); w[3]=0.13-(3.0*LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur1/100.0); w[4]=0.13-(5.0*LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur1/100.0);
  vec4 c = texture(Source, clamp(vTexCoord, lower_bound, upper_bound)) * w[0];
  for(int i=1;i<5;i++){
    float off = float(i);
    c.w += texture(Source, clamp(vTexCoord + vec2(off*texel.x, 0.0), lower_bound, upper_bound)).w * w[i];
    c.w += texture(Source, clamp(vTexCoord - vec2(off*texel.x, 0.0), lower_bound, upper_bound)).w * w[i];
  }
  FragColor = c;
}`;

// ── Passthrough (blit intermediate FBO texture to screen) ────────────────────
const BLIT_VERT = `#version 300 es
layout(location=0) in vec2 Position;
layout(location=1) in vec2 TexCoord;
out vec2 vTexCoord;
void main(){ gl_Position = vec4(Position, 0.0, 1.0); vTexCoord = TexCoord; }`;

const BLIT_FRAG = `#version 300 es
precision mediump float;
in vec2 vTexCoord;
out vec4 FragColor;
uniform sampler2D uTex;
void main(){ FragColor = texture(uTex, vTexCoord); }`;

const PASS3_VERT = PASS2_VERT; // identical structure, different uniform name

const PASS3_FRAG = `#version 300 es
precision highp float;
uniform vec4 LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur2;
uniform highp sampler2D Source;
in vec2 vTexCoord;
in vec2 texel, lower_bound, upper_bound;
layout(location=0) out vec4 FragColor;
void main(){
  float w[5]; w[0]=0.13; w[1]=0.13; w[2]=0.13-(LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur2/100.0); w[3]=0.13-(3.0*LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur2/100.0); w[4]=0.13-(5.0*LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur2/100.0);
  vec4 c = texture(Source, clamp(vTexCoord, lower_bound, upper_bound)) * w[0];
  for(int i=1;i<5;i++){
    float off = float(i);
    c.w += texture(Source, clamp(vTexCoord + vec2(0.0, off*texel.y), lower_bound, upper_bound)).w * w[i];
    c.w += texture(Source, clamp(vTexCoord - vec2(0.0, off*texel.y), lower_bound, upper_bound)).w * w[i];
  }
  FragColor = c;
}`;

const PASS4_VERT = `#version 300 es
uniform mat4 LIBRA_UBO_VERTEX_INSTANCE_MVP;
uniform vec4 LIBRA_PUSH_VERTEX_INSTANCE_SourceSize;
layout(location=0) in vec4 Position;
layout(location=1) in vec2 TexCoord;
out vec2 vTexCoord;
out vec2 texel;
void main(){
  gl_Position = LIBRA_UBO_VERTEX_INSTANCE_MVP * Position;
  vTexCoord = TexCoord;
  texel = LIBRA_PUSH_VERTEX_INSTANCE_SourceSize.zw;
}`;

const PASS4_FRAG = `#version 300 es
precision highp float;
uniform vec4 LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize;
uniform vec4 LIBRA_PUSH_FRAGMENT_INSTANCE_PassOutputSize1;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_contrast;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_screen_light;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_pixel_opacity;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_bg_smoothing;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_opacity;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_strength;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_x;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_y;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_x;
uniform float LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_y;
uniform highp sampler2D PassOutput1;
uniform highp sampler2D BACKGROUND;
uniform highp sampler2D Source;
uniform highp sampler2D COLOR_PALETTE;
in vec2 vTexCoord;
in vec2 texel;
layout(location=0) out vec4 FragColor;
void main(){
  vec2 tex = floor(LIBRA_PUSH_FRAGMENT_INSTANCE_PassOutputSize1.xy * vTexCoord);
  tex = (tex + vec2(0.5)) * LIBRA_PUSH_FRAGMENT_INSTANCE_PassOutputSize1.zw;
  vec4 foreground = texture(PassOutput1, tex - vec2(LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_x*texel.x, LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_y*texel.y));
  vec4 background = texture(BACKGROUND, vTexCoord);
  vec4 shadows    = texture(Source, vTexCoord - (vec2(LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_x*texel.x, LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_y*texel.y) + vec2(LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_x*texel.x, LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_y*texel.y)));
  background -= (((background - vec4(0.5)) * LIBRA_PUSH_FRAGMENT_INSTANCE_bg_smoothing) * float(foreground.w > 0.0));
  vec3 bg_col = texture(COLOR_PALETTE, vec2(0.25, 0.5)).xyz;
  vec3 mixed = clamp(vec3(bg_col.x + mix(-1.0,1.0,background.x), bg_col.y + mix(-1.0,1.0,background.y), bg_col.z + mix(-1.0,1.0,background.z)), vec3(0.0), vec3(1.0));
  background.xyz = mixed;
  float sw = min(shadows.w * LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_strength, 1.0);
  vec4 out_color = (shadows * sw) * (LIBRA_PUSH_FRAGMENT_INSTANCE_contrast * LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_opacity)
                 + background * (1.0 - sw * (LIBRA_PUSH_FRAGMENT_INSTANCE_contrast * LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_opacity));
  out_color = (foreground * foreground.w) * (1.0 - (foreground.w * foreground.w) * LIBRA_PUSH_FRAGMENT_INSTANCE_contrast)
            + out_color * (LIBRA_PUSH_FRAGMENT_INSTANCE_screen_light - (foreground.w * LIBRA_PUSH_FRAGMENT_INSTANCE_contrast) * LIBRA_PUSH_FRAGMENT_INSTANCE_pixel_opacity);
  FragColor = out_color;
}`;

// ── GbShader class ────────────────────────────────────────────────────────────

export class GbShader {
  constructor(canvas) {
    this._canvas = canvas;
    const gl = canvas.getContext("webgl2", { alpha: false });
    if (!gl) throw new Error("WebGL2 not supported");
    this._gl = gl;

    this._progBlit = this._mkProg(BLIT_VERT, BLIT_FRAG);
    this._prog0 = this._mkProg(PASS0_VERT, PASS0_FRAG);
    this._prog1 = this._mkProg(PASS1_VERT, PASS1_FRAG);
    this._prog2 = this._mkProg(PASS2_VERT, PASS2_FRAG);
    this._prog3 = this._mkProg(PASS3_VERT, PASS3_FRAG);
    this._prog4 = this._mkProg(PASS4_VERT, PASS4_FRAG);

    // Source texture (160×144 grayscale frame)
    this._srcTex = this._mkTex(_GB_W, _GB_H, gl.NEAREST);

    // Palette texture (2×1: bg at 0.25, dot at 0.75)
    // bg_col = dmg-palette.png [161,161,0] × RetroArch screen_light 0.85 → [137,137,0]
    this._palTex = this._mkPalTex([124, 124, 0, 255], [0, 90, 170, 255]);

    // FBO textures and framebuffers (sized to canvas on first use)
    this._sw = 0; this._sh = 0;
    this._fbo = [null, null, null, null];
    this._fbTex = [null, null, null, null];
    this._bgTex = null;

    // Quad buffers: flipped V for screen, normal for FBO
    this._quadScreen = this._mkQuad(true);
    this._quadFbo    = this._mkQuad(false);

    // Grayscale preprocessing buffer (reused each frame)
    this._grayBuf = new Uint8Array(_GB_W * _GB_H * 4);

    // Pre-shader grayscale mapping (brightest → darkest, 4 GB levels)
    this.grayLevels = [255, 143, 111, 47];

    // Shader parameters
    this.videoScale   = 2;
    this.contrast     = 0.85;
    this.screenLight  = 1.00;
    this.pixelOpacity = 1.00;
    this.shadowOpacity = 0.90;
    this.greyBalance  = 2.7;
    this.baselineAlpha = 0.05;
    this.adjBlending  = 0.76;
    this.blendMode    = 0.0;
    this.shadowSoftness = 1.0;  // blur iteration multiplier: 0.0=sharp, 2.0=soft
    this.shadowOffset   = 1.5;  // in GB pixels (multiplied by videoScale before use)
    this.shadowStrength = 3.0;  // amplifies shadows.w before blend (>1 compensates blur dilution)
  }

  // Set palette: bgHex = lightest GB color (LCD background), dotHex = darkest (active dot)
  setPalette(bgHex, dotHex) {
    const bg  = this._hex4(bgHex);
    const dot = this._hex4(dotHex);
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this._palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...bg, ...dot]));
  }

  _blit(tex) {
    const gl = this._gl;
    const sw = this._canvas.width, sh = this._canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sw, sh);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._progBlit);
    this._bindQuad(this._quadScreen);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    this._u1i(this._progBlit, "uTex", 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  render(rgba, level = 4) {
    const gl = this._gl;
    const sw = this._canvas.width;
    const sh = this._canvas.height;
    this.videoScale = sw / _GB_W;

    if (sw !== this._sw || sh !== this._sh) this._resize(sw, sh);

    // Preprocess: convert palette-colored pixels to grayscale for the shader
    this._toGray(rgba);

    // Upload source texture
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, _GB_W, _GB_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._grayBuf);

    const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const ss = [_GB_W, _GB_H, 1/_GB_W, 1/_GB_H];
    const fs = [sw, sh, 1/sw, 1/sh];

    // ── Pass 0: dot matrix ────────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[0]);
    gl.viewport(0, 0, sw, sh);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._prog0);
    this._bindQuad(this._quadFbo);
    this._umat(this._prog0, "LIBRA_UBO_VERTEX_INSTANCE_MVP", id);
    this._u4fv(this._prog0, "LIBRA_PUSH_VERTEX_INSTANCE_OutputSize", fs);
    this._u4fv(this._prog0, "LIBRA_PUSH_VERTEX_INSTANCE_SourceSize", ss);
    this._u1f(this._prog0, "LIBRA_PUSH_VERTEX_INSTANCE_video_scale", this.videoScale);
    this._u4fv(this._prog0, "LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize", ss);
    this._u1f(this._prog0, "LIBRA_PUSH_FRAGMENT_INSTANCE_baseline_alpha", this.baselineAlpha);
    this._u1f(this._prog0, "LIBRA_PUSH_FRAGMENT_INSTANCE_grey_balance", this.greyBalance);
    this._u1f(this._prog0, "LIBRA_PUSH_FRAGMENT_INSTANCE_response_time", 0.0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    this._u1i(this._prog0, "Source", 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._palTex);
    this._u1i(this._prog0, "COLOR_PALETTE", 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (level === 1) return this._blit(this._fbTex[0]);

    // ── Pass 1: gap blending ──────────────────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[1]);
    gl.viewport(0, 0, sw, sh);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._prog1);
    this._bindQuad(this._quadFbo);
    this._umat(this._prog1, "LIBRA_UBO_VERTEX_INSTANCE_MVP", id);
    this._u4fv(this._prog1, "LIBRA_PUSH_VERTEX_INSTANCE_OutputSize", fs);
    this._u4fv(this._prog1, "LIBRA_PUSH_VERTEX_INSTANCE_OriginalSize", ss);
    this._u4fv(this._prog1, "LIBRA_PUSH_VERTEX_INSTANCE_SourceSize", fs);
    this._u1f(this._prog1, "LIBRA_PUSH_VERTEX_INSTANCE_video_scale", this.videoScale);
    this._u1f(this._prog1, "LIBRA_PUSH_FRAGMENT_INSTANCE_blending_mode", this.blendMode);
    this._u1f(this._prog1, "LIBRA_PUSH_FRAGMENT_INSTANCE_adjacent_texel_alpha_blending", this.adjBlending);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._fbTex[0]);
    this._u1i(this._prog1, "Source", 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (level === 2) return this._blit(this._fbTex[1]);

    // ── Passes 2+3: shadow blur — iterated round(videoScale) times so the
    //   shadow spread stays ~4 GB pixels wide regardless of zoom level.
    //   Each iteration: horizontal blur (pass2) into fbo[2], then vertical
    //   blur (pass3) into fbo[3]. Next iteration reads fbo[3] as its source.
    //   At 1X the blur step already equals 1 source pixel, so the shadow
    //   footprint is disproportionately wide — skip blur entirely.
    const blurIter = this.videoScale < 1.5 ? 0 : Math.max(1, Math.round(this.videoScale * this.shadowSoftness));
    let blurSrcTex = this._fbTex[1];
    for (let iter = 0; iter < blurIter; iter++) {
      // Pass 2: horizontal shadow blur ────────────────────────────────────────
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[2]);
      gl.viewport(0, 0, sw, sh);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this._prog2);
      this._bindQuad(this._quadFbo);
      this._umat(this._prog2, "LIBRA_UBO_VERTEX_INSTANCE_MVP", id);
      this._u4fv(this._prog2, "LIBRA_PUSH_VERTEX_INSTANCE_OutputSize", fs);
      this._u4fv(this._prog2, "LIBRA_PUSH_VERTEX_INSTANCE_SourceSize", fs);
      this._u1f(this._prog2, "LIBRA_PUSH_VERTEX_INSTANCE_shadow_blur1", 2.0);
      this._u4fv(this._prog2, "LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize", fs);
      this._u1f(this._prog2, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur1", 2.0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, blurSrcTex);
      this._u1i(this._prog2, "Source", 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: vertical shadow blur ──────────────────────────────────────────
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[3]);
      gl.viewport(0, 0, sw, sh);
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this._prog3);
      this._bindQuad(this._quadFbo);
      this._umat(this._prog3, "LIBRA_UBO_VERTEX_INSTANCE_MVP", id);
      this._u4fv(this._prog3, "LIBRA_PUSH_VERTEX_INSTANCE_OutputSize", fs);
      this._u4fv(this._prog3, "LIBRA_PUSH_VERTEX_INSTANCE_SourceSize", fs);
      this._u1f(this._prog3, "LIBRA_PUSH_VERTEX_INSTANCE_shadow_blur2", 2.0);
      this._u4fv(this._prog3, "LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize", fs);
      this._u1f(this._prog3, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_blur2", 2.0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._fbTex[2]);
      this._u1i(this._prog3, "Source", 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      blurSrcTex = this._fbTex[3];
    }
    const shadowTex = blurIter > 0 ? this._fbTex[3] : this._fbTex[1];
    if (level === 3) return this._blit(shadowTex);

    // ── Pass 4: final composite to screen ────────────────────────────────────
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sw, sh);
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._prog4);
    this._bindQuad(this._quadScreen);
    this._umat(this._prog4, "LIBRA_UBO_VERTEX_INSTANCE_MVP", id);
    this._u4fv(this._prog4, "LIBRA_PUSH_VERTEX_INSTANCE_SourceSize", fs);
    this._u4fv(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_SourceSize", fs);
    this._u4fv(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_PassOutputSize1", fs);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_contrast", this.contrast);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_screen_light", this.screenLight);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_pixel_opacity", this.pixelOpacity);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_bg_smoothing", 0.0);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_opacity", this.shadowOpacity);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_strength", this.shadowStrength);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_x", -this.shadowOffset * this.videoScale);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_shadow_offset_y",  this.shadowOffset * this.videoScale);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_x", 0.0);
    this._u1f(this._prog4, "LIBRA_PUSH_FRAGMENT_INSTANCE_screen_offset_y", 0.0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._fbTex[1]); // pass1 = pixel data
    this._u1i(this._prog4, "PassOutput1", 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._palTex);
    this._u1i(this._prog4, "COLOR_PALETTE", 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, shadowTex); // shadows (blurred or raw at 1X)
    this._u1i(this._prog4, "Source", 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this._bgTex);
    this._u1i(this._prog4, "BACKGROUND", 3);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── private helpers ───────────────────────────────────────────────────────

  _toGray(rgba) {
    const n = _GB_W * _GB_H;
    const canon = this.grayLevels; // brightest → darkest: 255, 143, 111, 47

    // Compute integer luminance for every pixel
    const lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      lum[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o+1] + 0.114 * rgba[o+2]);
    }

    // Build a 0..255 → canon map.
    //
    // ≤4 distinct luminances (normal game frames): rank-map brightest→darkest
    // onto the 4 GB greys. Works for any emulator palette without hardcoding
    // its RGB values.
    //
    // >4 distinct luminances (in-device menu composite, AA edges, etc.): a pure
    // rank map would keep only the 4 brightest values and dump everything else
    // onto full-ink (47) — that blacked out the frozen game on the left side of
    // the menu. Snap each luminance to the nearest of the 4 ranks that actually
    // appear most often (or fall back to the canonical greys).
    const counts = new Uint32Array(256);
    for (let i = 0; i < n; i++) counts[lum[i]]++;
    const distinct = [];
    for (let v = 255; v >= 0; v--) if (counts[v]) distinct.push(v);

    const map = new Uint8Array(256);
    if (distinct.length <= 4) {
      // Unmapped slots default to darkest; only the observed ranks are used.
      // Spread ranks across the full 4-level palette so 2-tone images (QR code
      // full-screen, simple overlays) still get true white↔black contrast.
      // Without this, rank 0→255 and rank 1→143 (second-lightest) — QR looked washed out.
      map.fill(canon[canon.length - 1]);
      const n = distinct.length;
      distinct.forEach((v, i) => {
        const ri = n <= 1
          ? 0
          : Math.round(i * (canon.length - 1) / (n - 1));
        map[v] = canon[Math.min(ri, canon.length - 1)];
      });
    } else {
      // Pick up to 4 representative luminances (most frequent), sorted bright→dark,
      // then assign every source lum to the nearest representative → its canon grey.
      const top = distinct
        .slice()
        .sort((a, b) => counts[b] - counts[a] || b - a)
        .slice(0, 4)
        .sort((a, b) => b - a);
      const reps = top.length ? top : canon.slice();
      for (let v = 0; v < 256; v++) {
        let best = reps[0], bestD = Math.abs(v - best);
        for (let r = 1; r < reps.length; r++) {
          const d = Math.abs(v - reps[r]);
          if (d < bestD) { bestD = d; best = reps[r]; }
        }
        const ri = reps.indexOf(best);
        map[v] = canon[Math.min(ri, canon.length - 1)];
      }
    }

    for (let i = 0; i < n; i++) {
      const g = map[lum[i]];
      const o = i * 4;
      this._grayBuf[o] = this._grayBuf[o+1] = this._grayBuf[o+2] = g;
      this._grayBuf[o+3] = 255;
    }
  }

  _resize(sw, sh) {
    const gl = this._gl;
    this._sw = sw; this._sh = sh;
    for (let i = 0; i < 4; i++) {
      if (this._fbTex[i]) gl.deleteTexture(this._fbTex[i]);
      if (this._fbo[i])   gl.deleteFramebuffer(this._fbo[i]);
      this._fbTex[i] = this._mkTex(sw, sh, gl.NEAREST);
      this._fbo[i]   = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fbTex[i], 0);
    }
    // Solid 0.5-gray background texture
    if (this._bgTex) gl.deleteTexture(this._bgTex);
    const bgPx = new Uint8Array(sw * sh * 4).fill(128);
    for (let i = 3; i < bgPx.length; i += 4) bgPx[i] = 255;
    this._bgTex = this._mkTexData(sw, sh, bgPx, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _mkProg(vert, frag) {
    const gl = this._gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vert); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
      throw new Error("VS: " + gl.getShaderInfoLog(vs));
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, frag); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
      throw new Error("FS: " + gl.getShaderInfoLog(fs));
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error("Link: " + gl.getProgramInfoLog(prog));
    return prog;
  }

  _mkTex(w, h, filter) {
    const gl = this._gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _mkTexData(w, h, data, filter) {
    const gl = this._gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _mkPalTex(bg, dot) {
    const gl = this._gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...bg, ...dot]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _mkQuad(flipV) {
    const gl = this._gl;
    const v = flipV
      ? new Float32Array([-1,-1, 0,1,  1,-1, 1,1,  -1,1, 0,0,  1,1, 1,0])
      : new Float32Array([-1,-1, 0,0,  1,-1, 1,0,  -1,1, 0,1,  1,1, 1,1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    return buf;
  }

  _bindQuad(buf) {
    const gl = this._gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(1);
  }

  _u4fv(prog, name, v) {
    const loc = this._gl.getUniformLocation(prog, name);
    if (loc) this._gl.uniform4fv(loc, v);
  }
  _umat(prog, name, v) {
    const loc = this._gl.getUniformLocation(prog, name);
    if (loc) this._gl.uniformMatrix4fv(loc, false, v);
  }
  _u1f(prog, name, v) {
    const loc = this._gl.getUniformLocation(prog, name);
    if (loc) this._gl.uniform1f(loc, v);
  }
  _u1i(prog, name, v) {
    const loc = this._gl.getUniformLocation(prog, name);
    if (loc) this._gl.uniform1i(loc, v);
  }

  _hex4(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 255];
  }
}
