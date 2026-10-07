shader_type spatial;
render_mode cull_disabled;

uniform vec3 deep = vec3(0.04, 0.10, 0.14);
uniform vec3 shallow = vec3(0.10, 0.20, 0.24);
varying vec3 wpos;

void vertex() { wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }

float wave(vec2 p, float t) {
	return sin(p.x * 0.6 + t) * 0.5 + sin(p.y * 0.9 - t * 1.3) * 0.35 + sin((p.x + p.y) * 2.3 + t * 2.0) * 0.15;
}

void fragment() {
	float t = TIME * 0.8;
	vec2 p = wpos.xz;
	float e = 0.15;
	float h = wave(p, t);
	vec3 n = normalize(vec3(wave(p + vec2(e, 0.0), t) - h, 3.0, wave(p + vec2(0.0, e), t) - h));
	NORMAL = normalize((VIEW_MATRIX * vec4(n, 0.0)).xyz);
	float fres = pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), 4.0);
	ALBEDO = mix(deep, shallow, fres);
	ROUGHNESS = 0.03;
	SPECULAR = 0.8;
	METALLIC = 0.0;
}
