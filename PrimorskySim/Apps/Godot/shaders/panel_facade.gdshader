// Типовая панельная застройка: сетка окон по этажам (2.8 м) и пролётам (3.2 м), швы панелей,
// рамы, тёмное отражающее стекло, ночью — случайные освещённые окна. UV: x — метры вдоль стены, y — метры высоты.
// COLOR.rgb — оттенок панелей дома, COLOR.a — сид дома.
shader_type spatial;
render_mode cull_disabled;

global uniform float night;
uniform sampler2D concrete : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D concrete_n : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void fragment() {
	float seed = COLOR.a * 997.0;
	float floor_h = 2.8;
	float bay = mix(2.9, 3.6, hash(vec2(seed, 1.0)));
	vec2 uv = UV;
	vec2 cell = floor(vec2(uv.x / bay, uv.y / floor_h));
	vec2 f = fract(vec2(uv.x / bay, uv.y / floor_h));
	bool ground_floor = uv.y < floor_h;

	// окно с рамой и импостом
	float wx0 = 0.24, wx1 = 0.76, wy0 = 0.30, wy1 = 0.82;
	float inner = step(wx0, f.x) * step(f.x, wx1) * step(wy0, f.y) * step(f.y, wy1);
	float outer = step(wx0 - 0.025, f.x) * step(f.x, wx1 + 0.025) * step(wy0 - 0.03, f.y) * step(f.y, wy1 + 0.02);
	float frame = outer - inner;
	float mullion = inner * (1.0 - step(0.012, abs(f.x - 0.5))) + inner * (1.0 - step(0.012, abs(f.y - 0.62)));
	// подоконный отлив
	float sill = step(wx0 - 0.04, f.x) * step(f.x, wx1 + 0.04) * step(wy0 - 0.06, f.y) * step(f.y, wy0 - 0.03);

	// швы панелей — по этажу и по пролёту
	float seam = max(1.0 - smoothstep(0.0, 0.01, f.y), 1.0 - smoothstep(0.0, 0.005, min(f.x, 1.0 - f.x)));

	vec3 c = texture(concrete, uv * 0.35).rgb;
	vec3 wall = COLOR.rgb * (0.75 + 0.5 * c.r);
	// грязь у земли и потёки под окнами
	wall *= mix(0.78, 1.0, smoothstep(0.0, 1.5, uv.y));
	wall *= 1.0 - 0.10 * smoothstep(0.0, 0.3, wy0 - f.y) * step(f.y, wy0) * step(wx0, f.x) * step(f.x, wx1);
	wall *= 1.0 - seam * 0.35;

	vec3 albedo = wall;
	float rough = 0.88;
	float spec = 0.35;
	vec3 emit = vec3(0.0);
	NORMAL_MAP = texture(concrete_n, uv * 0.35).rgb;

	if (!ground_floor || hash(cell + seed) > 0.25) {
		if (frame + mullion > 0.5) {
			albedo = vec3(0.86, 0.86, 0.84);
			rough = 0.45;
		} else if (sill > 0.5) {
			albedo = vec3(0.55, 0.57, 0.6);
			rough = 0.4;
		} else if (inner > 0.5) {
			float h = hash(cell * 1.7 + seed);
			// занавески/шторы видны в части окон
			vec3 curtain = mix(vec3(0.55, 0.5, 0.42), vec3(0.75, 0.7, 0.62), hash(cell + 3.0));
			albedo = mix(vec3(0.03, 0.04, 0.05), curtain * 0.25, step(0.6, h) * step(0.45, f.x));
			rough = 0.04;
			spec = 0.9;
			NORMAL_MAP = vec3(0.5, 0.5, 1.0);
			float lit = step(0.55, hash(cell + seed * 1.3));
			vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.85, hash(cell + seed * 2.1)));
			emit = night * lit * warm * mix(1.2, 3.2, hash(cell + seed * 3.7));
		}
	}
	ALBEDO = albedo;
	ROUGHNESS = rough;
	SPECULAR = spec;
	EMISSION = emit;
}
