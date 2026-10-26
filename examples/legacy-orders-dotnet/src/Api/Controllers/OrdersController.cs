using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Acme.Orders.Api.Models;

namespace Acme.Orders.Api.Controllers
{
    // [HttpGet("this-is-a-comment")] -- comments never become routes.
    [ApiController]
    [Route("api/[controller]")]
    [Produces("application/json")]
    public class OrdersController : ControllerBase
    {
        private readonly IOrderRepository _orders;

        public OrdersController(IOrderRepository orders) => _orders = orders;

        [HttpGet]
        public async Task<IEnumerable<OrderDto>> List([FromQuery] OrderStatus? status, int page = 1)
            => await _orders.ListAsync(status, page);

        [HttpGet("{id:int}")]
        public async Task<ActionResult<OrderDto>> GetOrder(int id, [FromHeader(Name = "X-Tenant")] string tenant)
            => Ok(await _orders.GetAsync(id));

        [HttpPost]
        [Consumes("application/json")]
        public async Task<ActionResult<OrderDto>> Create(CreateOrderRequest request)
            => Ok(await _orders.CreateAsync(request));

        [HttpPost("{id:int}/cancel")]
        public async Task<IActionResult> Cancel(int id, [FromBody] CancelOrderRequest request)
        {
            await _orders.CancelAsync(id, request.Reason);
            return NoContent();
        }

        [HttpDelete("{id:int}")]
        public async Task<IActionResult> Delete(int id)
        {
            await _orders.DeleteAsync(id);
            return NoContent();
        }

        [NonAction]
        public void Warm() { }
    }
}
