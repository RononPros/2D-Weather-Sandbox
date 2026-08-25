#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count == 0:
        raise RuntimeError(f'Patch anchor not found: {label}')
    if count > 1:
        raise RuntimeError(f'Patch anchor is ambiguous ({count} matches): {label}')
    return text.replace(old, new, 1)


def patch_index():
    path = Path('index.html')
    text = path.read_text(encoding='utf-8')
    if 'terrainImport.js' in text:
        return
    old = '    <script type="text/javascript" src="app.js"></script>'
    new = '    <script type="text/javascript" src="terrainImport.js"></script>\n' + old
    text = replace_once(text, old, new, 'index app.js script tag')
    path.write_text(text, encoding='utf-8')


def patch_setup_shader():
    path = Path('shaders/fragment/setupShader.frag')
    text = path.read_text(encoding='utf-8')
    if 'uniform bool useRealTerrain;' in text:
        return

    text = replace_once(
        text,
        'uniform float heightMult;\n',
        '''uniform float heightMult;\n\nuniform bool useRealTerrain;\nuniform sampler2D terrainProfileTex;\nuniform float terrainBaseAltitude;\nuniform float terrainSeaLevel;\nuniform bool terrainSeaAsWater;\n''',
        'setup terrain uniforms',
    )

    text = replace_once(
        text,
        '  float height = 0.0;\n  float height_m = 0.0;\n\n  if (heightMult < 0.05) { // all sea\n',
        '''  float height = 0.0;\n  float height_m = 0.0;\n  float surfaceElevation_m = 0.0;\n  bool surfaceIsWater = false;\n\n  if (useRealTerrain) {\n    surfaceElevation_m = texture(terrainProfileTex, vec2(clamp(texCoord.x, 0.0, 1.0), 0.5)).r;\n    height_m = max(surfaceElevation_m - terrainBaseAltitude, 0.0);\n    height = clamp(height_m / simHeight, 0.0, 0.98);\n    surfaceIsWater = terrainSeaAsWater && surfaceElevation_m <= terrainSeaLevel;\n  } else if (heightMult < 0.05) { // all sea\n''',
        'setup real terrain branch',
    )

    text = replace_once(
        text,
        '    height *= heightMult;\n    height_m = height * simHeight; // sim height\n  }\n\n  if (texCoord.y < texelSize.y || texCoord.y < height) {',
        '''    height *= heightMult;\n    height_m = height * simHeight; // sim height\n  }\n\n  if (!useRealTerrain) {\n    surfaceElevation_m = height_m;\n    surfaceIsWater = height < texelSize.y;\n  }\n\n  if (texCoord.y < texelSize.y || texCoord.y < height) {''',
        'setup procedural terrain footer',
    )

    text = replace_once(
        text,
        '    if (height < texelSize.y) {',
        '    if (surfaceIsWater) {',
        'setup water classification',
    )

    text = replace_once(
        text,
        '      water[SNOW] = max(map_rangeC(height_m, 2000.0, 5000.0, 0.0, 100.0), 0.);',
        '      water[SNOW] = max(map_rangeC(surfaceElevation_m, 2000.0, 5000.0, 0.0, 100.0), 0.);',
        'setup snow uses absolute elevation',
    )

    path.write_text(text, encoding='utf-8')


def patch_app():
    path = Path('app.js')
    text = path.read_text(encoding='utf-8')
    if 'const hasRealTerrain = Boolean(window.realWorldTerrain' in text:
        return

    text = replace_once(
        text,
        '    const inSimAlt = y * (simHeight / sim_res_y);',
        '    const inSimAlt = (window.realWorldTerrain?.enabled ? window.realWorldTerrain.baseAltitude : 0) + y * (simHeight / sim_res_y);',
        'sounding absolute altitude',
    )

    text = replace_once(
        text,
        "    while (soundingData[soundingDataIndex]['alt'] < inSimAlt ||\n           sampleIsInvalid(soundingData[soundingDataIndex])) {",
        "    while (soundingDataIndex > 0 && (soundingData[soundingDataIndex]['alt'] < inSimAlt ||\n           sampleIsInvalid(soundingData[soundingDataIndex]))) {",
        'sounding bounds guard',
    )

    text = replace_once(
        text,
        "    if (startLatitude) {\n      guiControls.latitude = startLatitude;\n    }\n",
        "    if (startLatitude) {\n      guiControls.latitude = startLatitude;\n    }\n\n    // A real-world cross-section has physical end points, so do not wrap it around.\n    if (window.realWorldTerrain?.enabled) {\n      guiControls.wrapHorizontally = false;\n      cam.wrapHorizontally = false;\n      horizontalDisplayMult = 1.0;\n    }\n",
        'disable wrapping for real terrain',
    )

    text = replace_once(
        text,
        '    let altitude = y / (sim_res_y + 1) * guiControls.simHeight;',
        '    let altitude = (window.realWorldTerrain?.enabled ? window.realWorldTerrain.baseAltitude : 0) + y / (sim_res_y + 1) * guiControls.simHeight;',
        'initial profile absolute altitude',
    )

    text = replace_once(
        text,
        '  cellHeight = guiControls.simHeight / sim_res_y; // in meters\n\n  // Set constant uniforms',
        '''  cellHeight = guiControls.simHeight / sim_res_y; // in meters\n\n  // Optional real-world terrain profile. The CPU-side loader resamples the DEM\n  // to exactly one elevation value per model column, then the setup shader\n  // turns every cell below that elevation into terrain.\n  const hasRealTerrain = Boolean(window.realWorldTerrain?.enabled && window.realWorldTerrain.elevations?.length);\n  const terrainBaseAltitude = hasRealTerrain ? Number(window.realWorldTerrain.baseAltitude || 0) : 0;\n  const terrainSeaLevel = hasRealTerrain ? Number(window.realWorldTerrain.seaLevel || 0) : 0;\n  const terrainSeaAsWater = hasRealTerrain ? Boolean(window.realWorldTerrain.seaAsWater) : false;\n  const terrainProfileTexture = gl.createTexture();\n  const terrainProfileData = hasRealTerrain\n    ? window.getRealWorldTerrainProfile(sim_res_x)\n    : new Float32Array(sim_res_x);\n\n  gl.activeTexture(gl.TEXTURE11);\n  gl.bindTexture(gl.TEXTURE_2D, terrainProfileTexture);\n  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sim_res_x, 1, 0, gl.RED, gl.FLOAT, terrainProfileData);\n  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);\n  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);\n  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);\n  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\n  gl.activeTexture(gl.TEXTURE0);\n\n  // Set constant uniforms''',
        'terrain texture creation',
    )

    text = replace_once(
        text,
        "  gl.uniform1f(gl.getUniformLocation(setupProgram, 'simHeight'), guiControls.simHeight);\n\n  gl.uniform4fv(gl.getUniformLocation(setupProgram, 'initial_Tv'), initial_T);",
        "  gl.uniform1f(gl.getUniformLocation(setupProgram, 'simHeight'), guiControls.simHeight);\n  gl.uniform1i(gl.getUniformLocation(setupProgram, 'useRealTerrain'), hasRealTerrain ? 1 : 0);\n  gl.uniform1i(gl.getUniformLocation(setupProgram, 'terrainProfileTex'), 11);\n  gl.uniform1f(gl.getUniformLocation(setupProgram, 'terrainBaseAltitude'), terrainBaseAltitude);\n  gl.uniform1f(gl.getUniformLocation(setupProgram, 'terrainSeaLevel'), terrainSeaLevel);\n  gl.uniform1i(gl.getUniformLocation(setupProgram, 'terrainSeaAsWater'), terrainSeaAsWater ? 1 : 0);\n\n  gl.uniform4fv(gl.getUniformLocation(setupProgram, 'initial_Tv'), initial_T);",
        'terrain setup uniforms',
    )

    text = replace_once(
        text,
        "      gl.useProgram(setupProgram);\n      gl.uniform1f(gl.getUniformLocation(setupProgram, 'seed'), mouseXinSim);",
        "      gl.useProgram(setupProgram);\n      if (hasRealTerrain) {\n        gl.activeTexture(gl.TEXTURE11);\n        gl.bindTexture(gl.TEXTURE_2D, terrainProfileTexture);\n        gl.activeTexture(gl.TEXTURE0);\n      }\n      gl.uniform1f(gl.getUniformLocation(setupProgram, 'seed'), mouseXinSim);",
        'bind terrain profile during setup preview',
    )

    path.write_text(text, encoding='utf-8')


def main():
    patch_index()
    patch_setup_shader()
    patch_app()
    print('Real-world terrain integration patch applied successfully.')


if __name__ == '__main__':
    main()
