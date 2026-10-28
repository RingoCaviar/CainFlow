import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeSerializer} from '../js/nodes/node-serializer.js';
import {shouldRunNodeForEachInput,buildInputBatches} from '../js/features/execution/workflow-runner.js';
test('unmounted resize parameters preserve dimensions, empty values, quality and false aspect lock when saved',()=>{
 const node={id:'resize',type:'ImageResize',x:1,y:2,data:{resizeMode:'dimensions',scalePercent:65,targetWidth:'640',targetHeight:'',keepAspect:false,quality:71}};
 const [saved]=createNodeSerializer({state:{nodes:new Map([[node.id,node]]),connections:[],canvas:{}},documentRef:{getElementById:()=>null,querySelectorAll:()=>[]}}).serializeNodes();
 assert.deepEqual(Object.fromEntries(['resizeMode','scalePercent','targetWidth','targetHeight','keepAspect','quality'].map(key=>[key,saved[key]])),node.data);
});
test('single-image processors keep the complete source batch intact while their handler consumes its primary image once',()=>{
 const images=['first','second','third'];
 for(const type of ['ImageResize','ColorReset','CameraControl']){
  const node={type},inputs={image:images};
  assert.equal(shouldRunNodeForEachInput(node,inputs),false);
  assert.deepEqual(buildInputBatches(node,inputs),[inputs]);
  assert.deepEqual(images,['first','second','third']);
 }
});
