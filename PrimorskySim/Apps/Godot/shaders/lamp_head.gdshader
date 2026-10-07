shader_type spatial;
global uniform float night;
void fragment() {
	ALBEDO = vec3(0.2);
	ROUGHNESS = 0.3;
	EMISSION = vec3(1.0, 0.78, 0.5) * night * 6.0;
}
