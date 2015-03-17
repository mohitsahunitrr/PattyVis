/* global requestAnimationFrame:false */
(function() {
  'use strict';

  function PointcloudService(THREE, Potree, POCLoader, $window, $rootScope,
    DrivemapService,
    SitesService, CameraService, SceneService,
    PathControls, SiteBoxService, MeasuringService) {

    var me = this;

    this.elRenderArea = null;

    me.settings = {
      pointCountTarget: 1.0,
      pointSize: 0.2,
      opacity: 1,
      showSkybox: true,
      interpolate: false,
      showStats: false,
      pointSizeType: Potree.PointSizeType.ATTENUATED,
      pointSizeTypes: Potree.PointSizeType,
      pointColorType: Potree.PointColorType.RGB,
      pointColorTypes: Potree.PointColorType,
      pointShapes: Potree.PointShape,
      pointShape: Potree.PointShape.CIRCLE,
      clipMode: Potree.ClipMode.HIGHLIGHT_INSIDE,
      clipModes: Potree.ClipMode
    };

    me.stats = {
      nrPoints: 0,
      nrNodes: 0,
      sceneCoordinates: {
        x: 0,
        y: 0,
        z: 0
      },
      lasCoordinates: {
        x: 0,
        y: 0,
        z: 0,
        crs: 'unknown'
      }
    };

    this.renderer = null;
    var camera;
    var scene;
    var pointcloud;
    var sitePointcloud;

    var skybox;

    me.pathMesh = null;

    var referenceFrame = SceneService.referenceFrame;
    var mouse = {
      x: 0,
      y: 0
    };

    function loadSkybox(path) {
      var camera = new THREE.PerspectiveCamera(75, $window.innerWidth / $window.innerHeight, 1, 100000);
      var scene = new THREE.Scene();

      var format = '.jpg';
      var urls = [
        path + 'px' + format, path + 'nx' + format,
        path + 'py' + format, path + 'ny' + format,
        path + 'pz' + format, path + 'nz' + format
      ];

      var textureCube = THREE.ImageUtils.loadTextureCube(urls, new THREE.CubeRefractionMapping());

      var shader = THREE.ShaderLib.cube;
      shader.uniforms.tCube.value = textureCube;

      var material = new THREE.ShaderMaterial({

          fragmentShader: shader.fragmentShader,
          vertexShader: shader.vertexShader,
          uniforms: shader.uniforms,
          depthWrite: false,
          side: THREE.BackSide

        }),

        mesh = new THREE.Mesh(new THREE.BoxGeometry(100000, 100000, 100000), material);
      scene.add(mesh);

      return {
        'camera': camera,
        'scene': scene
      };
    }

    function getMousePointCloudIntersection() {
      var vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
      vector.unproject(camera);
      var direction = vector.sub(camera.position).normalize();
      var ray = new THREE.Ray(camera.position, direction);

      var pointClouds = [];
      scene.traverse(function(object) {
        if (object instanceof Potree.PointCloudOctree) {
          pointClouds.push(object);
        }
      });

      var closestPoint = null;
      var closestPointDistance = null;

      for (var i = 0; i < pointClouds.length; i++) {
        var pointcloud = pointClouds[i];
        var point = pointcloud.pick(me.renderer, camera, ray, {
          accuracy: 0.5
        });

        if (!point) {
          continue;
        }

        var distance = camera.position.distanceTo(point.position);

        if (!closestPoint || distance < closestPointDistance) {
          closestPoint = point;
          closestPointDistance = distance;
        }
      }

      return closestPoint ? closestPoint.position : null;
    }

    function updateStats() {
      if (me.settings.showStats) {
        if (pointcloud) {
          me.stats.nrPoints = pointcloud.numVisiblePoints;
          me.stats.nrNodes = pointcloud.numVisibleNodes;
        } else {
          me.stats.nrPoints = 'none';
          me.stats.nrNodes = 'none';
        }

        var I = getMousePointCloudIntersection();
        if (I) {
          var sceneCoordinates = I;
          me.stats.sceneCoordinates.x = sceneCoordinates.x.toFixed(2);
          me.stats.sceneCoordinates.y = sceneCoordinates.y.toFixed(2);
          me.stats.sceneCoordinates.z = sceneCoordinates.z.toFixed(2);
          var geoCoordinates = SceneService.toGeo(sceneCoordinates);
          me.stats.lasCoordinates.x = geoCoordinates.x.toFixed(2);
          me.stats.lasCoordinates.y = geoCoordinates.y.toFixed(2);
          me.stats.lasCoordinates.z = geoCoordinates.z.toFixed(2);
        }

        // stats are changed in requestAnimationFrame loop,
        // which is outside the AngularJS $digest loop
        // to have changes to stats propagated to angular, we need to trigger a digest
        $rootScope.$digest();
      }
    }

    function onMouseMove(event) {
      mouse.x = (event.clientX / me.renderer.domElement.clientWidth) * 2 - 1;
      mouse.y = -(event.clientY / me.renderer.domElement.clientHeight) * 2 + 1;
    }

    this.initThree = function() {
      var width = $window.innerWidth;
      var height = $window.innerHeight;

      scene = SceneService.getScene();
      camera = CameraService.camera;

      me.renderer = new THREE.WebGLRenderer();
      me.renderer.setSize(width, height);
      me.renderer.autoClear = false;
      me.renderer.domElement.addEventListener('mousemove', onMouseMove, false);

      MeasuringService.init(me.renderer);

      skybox = loadSkybox('bower_components/potree/resources/textures/skybox/');

      // enable frag_depth extension for the interpolation shader, if available
      me.renderer.context.getExtension('EXT_frag_depth');

      SiteBoxService.init(mouse);

      SiteBoxService.listenTo(me.renderer.domElement);

      DrivemapService.ready.then(this.loadPointcloud);
      SitesService.ready.then(this.loadSite);
    };

    this.loadPointcloud = function() {
      // load pointcloud
      var pointcloudPath = DrivemapService.getPointcloudUrl();
      me.stats.lasCoordinates.crs = DrivemapService.getCrs();

      POCLoader.load(pointcloudPath, function(geometry) {
        pointcloud = new Potree.PointCloudOctree(geometry);

        pointcloud.material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
        pointcloud.material.size = me.settings.pointSize;
        pointcloud.visiblePointsTarget = me.settings.pointCountTarget * 1000 * 1000;

        referenceFrame.add(pointcloud);
        referenceFrame.updateMatrixWorld(true); // doesn't seem to do anything
        // reference frame position to pointcloud position:
        referenceFrame.position.set(-pointcloud.position.x, -pointcloud.position.y, 0);
        // rotates to some unknown orientation:
        referenceFrame.updateMatrixWorld(true);
        // rotates point cloud to align with horizon
        referenceFrame.applyMatrix(new THREE.Matrix4().set(
          1, 0, 0, 0,
          0, 0, 1, 0,
          0, -1, 0, 0,
          0, 0, 0, 1
        ));
        referenceFrame.updateMatrixWorld(true);

        var myPath = DrivemapService.getCameraPath().map(
          function(coord) {
            return SceneService.toLocal(new THREE.Vector3(coord[0], coord[1], coord[2]));
          }
        );

        var lookPath = DrivemapService.getLookPath().map(
          function(coord) {
            return SceneService.toLocal(new THREE.Vector3(coord[0], coord[1], coord[2]));
          }
        );

		
        //PathControls.init(camera, myPath, lookPath, me.renderer.domElement);
		PathControls.init(camera, myPath, lookPath, me.elRenderArea);

		
		
        me.pathMesh = PathControls.createPath();
        scene.add(me.pathMesh);
        me.pathMesh.visible = false; // disabled by default
        MeasuringService.setPointcloud(pointcloud);
      });
    };

    this.loadSite = function() {
      // load pointcloud
      var site = SitesService.getById(162);
      var pointcloudPath = site.pointcloud;

      POCLoader.load(pointcloudPath, function(geometry) {
        sitePointcloud = new Potree.PointCloudOctree(geometry);

        sitePointcloud.material.pointSizeType = Potree.PointSizeType.ADAPTIVE;
        sitePointcloud.material.size = me.settings.pointSize;
        sitePointcloud.visiblePointsTarget = me.settings.pointCountTarget * 1000 * 1000;

        referenceFrame.add(sitePointcloud);
        MeasuringService.setSitePointcloud(sitePointcloud);
      });

      /*
      var meshPath = site.mesh.data_location;
      var meshMtlPath = site.mesh.mtl_location;

      var objmtl_loader = new THREE.OBJMTLLoader();

      objmtl_loader.load(meshPath, meshMtlPath, function(object) {
          referenceFrame.add(object);
      }, function(){
        return 1;
      }, function() {
        console.log('Error while loading mesh for site');
      });

      var reconstructionMeshPath = site.reconstruction_mesh[0].data_location;
      var obj_loader = new THREE.OBJLoader();

      obj_loader.load(reconstructionMeshPath, function(object) {
          var osg = site.reconstruction_mesh[0].osg_position;
          // TODO perform projection?
          object.scale.set(osg.xs, osg.ys, osg.zs);
          object.position.set(osg.x, osg.y, osg.z);
          referenceFrame.add(object);
      }, function(){
        return 1;
      }, function() {
        console.log('Error while loading reconstruction mesh for site');
      });

      */

    };

    function addTextLabel(message, position) {
      var canvas = document.createElement('canvas');
      var context = canvas.getContext('2d');
      // context.font = "Bold " + fontsize + "px " + fontface;

      // get size data (height depends only on font size)
      // var metrics = context.measureText(message);

      // background color
      // context.fillStyle = "rgba(" + backgroundColor.r + "," + backgroundColor.g +
      // ","
      // + backgroundColor.b + "," + backgroundColor.a + ")";

      // context.strokeStyle = "rgba(" + borderColor.r + "," + borderColor.g + ","
      // + borderColor.b + "," + borderColor.a + ")";

      // context.lineWidth = borderThickness;
      // roundRect(context, borderThickness/2, borderThickness/2, textWidth +
      // borderThickness, fontsize * 1.4 + borderThickness, 6);
      // 1.4 is extra height factor for text below baseline: g,j,p,q.

      // text color
      // context.fillStyle = "rgba(0, 0, 0, 1.0)";

      // context.fillText( message, borderThickness, fontsize + borderThickness);

      var imageObj = new Image();
      imageObj.onload = function() {
        context.drawImage(imageObj, 10, 10);
        context.font = '40pt Calibri';
        context.fillText(message, 30, 70);
        // canvas contents will be used for a texture
        var texture = new THREE.Texture(canvas);
        texture.needsUpdate = true;

        var spriteMaterial = new THREE.SpriteMaterial({
          map: texture,
          useScreenCoordinates: false,
        });
        var sprite = new THREE.Sprite(spriteMaterial);
        // sprite.scale.set(100,50,1.0);
        sprite.scale.set(10, 5, 1.0);

        sprite.position.copy(position);
        referenceFrame.add(sprite);
      };
      imageObj.src = 'data/label-small.png';
    }

    this.goHome = function() {

      PathControls.goHome();

    };

    this.lookAtSite = function(site) {
      var coordGeo = SitesService.centerOfSite(site);
      var posGeo = new THREE.Vector3(coordGeo[0], coordGeo[1], coordGeo[2]);
      var posLocal = SceneService.toLocal(posGeo);
      //camera.lookAt(posLocal);
      //var camPos = posLocal.clone().setY(posLocal.y + 20);
      //camera.position.copy(camPos);

      PathControls.goToPointOnRoad(posLocal);
      PathControls.lookat(posLocal);

    };

    this.enterOrbitMode = function(site) {
      SitesService.selectSite(site);

      // TODO replace PathControls with OrbitControls
      // TODO replace camera drivemap toggles (rails, free, demo) with orbit exit button
      // TODO Show pointcloud of site if available
    };

    this.exitOrbitMode = function() {
      // TODO Hide pointcloud of site if shown
      // TODO replace OrbitControls with PathControls
      // TODO replace orbit exit button with camera drivemap toggles (rails, free, demo)

      SitesService.clearSiteSelection();
    };

    this.showLabel = function(site) {
      var message = site.description_site; // jshint ignore:line
      var center = SitesService.centerOfSite(site);
      var bbox = SitesService.getBoundingBox(site);
      var maxAltIndex = 5;
      var top = bbox[maxAltIndex];
      var labelPosition = new THREE.Vector3(center[0], center[1], top);
      addTextLabel(message, labelPosition);
    };

    this.update = function() {

      if (pointcloud) {
        pointcloud.material.clipMode = me.settings.clipMode;
        pointcloud.material.size = me.settings.pointSize;
        pointcloud.visiblePointsTarget = me.settings.pointCountTarget * 1000 * 1000;
        pointcloud.material.opacity = me.settings.opacity;
        pointcloud.material.pointSizeType = me.settings.pointSizeType;
        pointcloud.material.pointColorType = me.settings.pointColorType;
        pointcloud.material.pointShape = me.settings.pointShape;
        pointcloud.material.interpolate = me.settings.interpolate;
        pointcloud.material.heightMin = 0;
        pointcloud.material.heightMax = 8;
        pointcloud.material.intensityMin = 0;
        pointcloud.material.intensityMax = 65000;

        pointcloud.update(camera, me.renderer);

      }

      if (sitePointcloud) {
        sitePointcloud.material.clipMode = me.settings.clipMode;
        sitePointcloud.material.size = me.settings.pointSize;
        sitePointcloud.visiblePointsTarget = me.settings.pointCountTarget * 1000 * 1000;
        sitePointcloud.material.opacity = me.settings.opacity;
        sitePointcloud.material.pointSizeType = me.settings.pointSizeType;
        sitePointcloud.material.pointColorType = me.settings.pointColorType;
        sitePointcloud.material.pointShape = me.settings.pointShape;
        sitePointcloud.material.interpolate = me.settings.interpolate;
        sitePointcloud.material.heightMin = 0;
        sitePointcloud.material.heightMax = 8;
        sitePointcloud.material.intensityMin = 0;
        sitePointcloud.material.intensityMax = 65000;

        sitePointcloud.update(camera, me.renderer);
      }


      PathControls.updateInput();

      MeasuringService.update();

      CameraService.update();

      updateStats();
    };

    this.render = function() {
      // resize
      var width = $window.innerWidth;
      var height = $window.innerHeight;
      var aspect = width / height;

      camera.aspect = aspect;
      camera.updateProjectionMatrix();

      me.renderer.setSize(width, height);

      // render skybox
      if (me.settings.showSkybox) {
        skybox.camera.rotation.copy(camera.rotation);
        me.renderer.render(skybox.scene, skybox.camera);
      }

      SiteBoxService.siteBoxSelection(mouse.x, mouse.y);

      // render scene
      me.renderer.render(scene, camera);

      MeasuringService.render();
    };

    this.loop = function() {
      requestAnimationFrame(me.loop);

      me.update();
      me.render();
    };

    this.attachCanvas = function(el) {
      me.elRenderArea = el;
      me.initThree();
      var canvas = me.renderer.domElement;
      el.appendChild(canvas);
      me.loop();
    };
  }

  angular.module('pattyApp.pointcloud')
    .service('PointcloudService', PointcloudService);
})();
