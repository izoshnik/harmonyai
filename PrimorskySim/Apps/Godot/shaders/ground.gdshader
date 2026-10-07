// Мировые UV (метры по XZ) для асфальта, плитки, травы, земли. Разметка дорог — отдельной геометрией.
shader_type spatial;
render_mode cull_disabled;

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D rough_tex : hint_roughness_r, filter_linear_mipmap_anisotropic, repeat_enable;
uniform float tile_m = 4.0;
uniform vec3 tint = vec3(1.0);
uniform float rough_min = 0.5;
uniform float wetness : hint_range(0.0, 1.0) = 0.0;
varying vec3 wpos;

void vertex() { wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }

void fragment() {
	vec2 uv = wpos.xz / tile_m;
	// разбивка повторяемости: второй слой в другом масштабе
	vec3 a = texture(albedo_tex, uv).rgb;
	vec3 b = texture(albedo_tex, uv * 0.137 + 0.31).rgb;
	ALBEDO = mix(a, a * b * 1.8, 0.35) * tint * mix(1.0, 0.55, wetness);
	NORMAL_MAP = texture(normal_tex, uv).rgb;
	ROUGHNESS = mix(max(texture(rough_tex, uv).r, rough_min), 0.08, wetness);
}
