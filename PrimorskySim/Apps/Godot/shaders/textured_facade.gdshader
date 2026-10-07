// Фасад по PBR-текстуре (кирпич/офис). UV в метрах, tile_m — размер текстуры в метрах. Ночная подсветка окон из emission-карты.
shader_type spatial;
render_mode cull_disabled;

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D rough_tex : hint_roughness_r, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D emission_tex : source_color, filter_linear_mipmap, repeat_enable;
uniform vec2 tile_m = vec2(18.0, 18.0);
uniform float metallic = 0.0;
global uniform float night;

void fragment() {
	vec2 uv = vec2(UV.x / tile_m.x + COLOR.a * 7.0, UV.y / tile_m.y);
	ALBEDO = texture(albedo_tex, uv).rgb * mix(vec3(1.0), COLOR.rgb, 0.35);
	NORMAL_MAP = texture(normal_tex, uv).rgb;
	ROUGHNESS = texture(rough_tex, uv).r;
	METALLIC = metallic;
	EMISSION = texture(emission_tex, uv).rgb * night * 2.5;
}
