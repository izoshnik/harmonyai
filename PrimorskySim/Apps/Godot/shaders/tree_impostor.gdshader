// Дерево-импостор: два перекрещённых квада, каждый берёт свой ракурс из атласа 4×1 (рендер исходной фотограмметрии).
// UV.x уже указывает на нужную четверть атласа. Лёгкое покачивание на ветру.
shader_type spatial;
render_mode cull_disabled, depth_prepass_alpha;

uniform sampler2D atlas : source_color, filter_linear_mipmap, repeat_disable;
uniform float wind = 0.15;

void vertex() {
	float sway = sin(TIME * 1.3 + MODEL_MATRIX[3].x * 0.13 + MODEL_MATRIX[3].z * 0.11) * wind * UV2.y;
	VERTEX.x += sway;
}

void fragment() {
	vec4 c = texture(atlas, UV);
	if (c.a < 0.45) { discard; }
	ALBEDO = c.rgb * COLOR.rgb;
	ROUGHNESS = 0.85;
	BACKLIGHT = vec3(0.25, 0.3, 0.15);
	// условная нормаль «вверх-наружу» мягче освещает крону
	NORMAL = normalize(mix(NORMAL, (VIEW_MATRIX * vec4(0.0, 1.0, 0.0, 0.0)).xyz, 0.4));
}
